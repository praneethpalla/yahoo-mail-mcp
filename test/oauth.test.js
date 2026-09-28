// Offline tests for OAuth: sign-in page, MFA, lockout, signed expiring tokens, refresh rotation,
// auth codes, and startup safety. Uses local servers with dummy credentials; nothing connects to Yahoo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YahooMailMCPServer } from '../server.js';
import { hashPassword, generateTotpSecret, totpAt } from '../auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MFA_BASE = `http://127.0.0.1:${PORT + 3}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'a long test password';
const PASSWORD_HASH = hashPassword(PASSWORD);
const TOTP_SECRET = generateTotpSecret();
const baseEnv = {
    PATH: process.env.PATH,
    ENV_FILE: '/dev/null',
    TRANSPORT_MODE: 'http',
    YAHOO_EMAIL: 'dummy@example.invalid',
    YAHOO_APP_PASSWORD_COMMAND: 'printf dummy'
};
const oauthEnv = { OAUTH_CLIENT_ID: 'test-client', OAUTH_CLIENT_SECRET: 'sec:ret' };
const loginEnv = { AUTH_USERNAME: 'owner', AUTH_PASSWORD_HASH: PASSWORD_HASH };
const currentTotp = (offset = 0) => totpAt(TOTP_SECRET, Math.floor(Date.now() / 30000) + offset);
let child;
let mfaChild;

function startServer(env, port) {
    const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...baseEnv, PORT: String(port), ...env } });
    let out = '';
    return new Promise((resolve, reject) => {
        proc.stderr.on('data', d => { out += d; if (out.includes('running on port')) resolve(proc); });
        proc.on('exit', code => reject(Object.assign(new Error(`exited ${code}`), { code, out })));
    });
}

before(async () => {
    // Password-only sign-in (MFA codes are single-use per 30 s, which would limit how many flows a test can run)
    child = await startServer({ ...oauthEnv, ...loginEnv, ALLOW_CLIENT_CREDENTIALS: 'true' }, PORT);
    // Password + authenticator code, client credentials left at the default (off)
    mfaChild = await startServer({ ...oauthEnv, ...loginEnv, AUTH_TOTP_SECRET: TOTP_SECRET }, PORT + 3);
});
after(() => { child?.kill(); mfaChild?.kill(); });

const basic = 'Basic ' + Buffer.from('test-client:sec:ret').toString('base64');
const tokenRequest = (body, auth = basic, base = BASE) => fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body)
});
const listTools = (accessToken) => fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});

async function openLoginPage(verifier, base = BASE, redirect = REDIRECT) {
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const res = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code', client_id: 'test-client', redirect_uri: redirect,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's1'
    }));
    const html = await res.text();
    return { res, html, request: (html.match(/name="request" value="([^"]+)"/) || [])[1] };
}

const submitLogin = (fields, base = BASE) => fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual'
});

async function getCode(verifier) {
    const { request } = await openLoginPage(verifier);
    const res = await submitLogin({ request, username: 'owner', password: PASSWORD });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin, 'https://claude.ai');
    assert.equal(location.searchParams.get('state'), 's1');
    return location.searchParams.get('code');
}

test('the authorize endpoint shows a sign-in page with protective headers', async () => {
    const { res, html, request } = await openLoginPage('page-check');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(html, /Sign in to Yahoo Mail MCP/);
    assert.match(html, /claude\.ai/);
    assert.ok(!html.includes('name="totp"'), 'no MFA field when MFA is not configured');
    assert.ok(request);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(res.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);
});

test('wrong password or username shows the form again without issuing a code', async () => {
    const { request } = await openLoginPage('wrong-pw');
    const wrongPw = await submitLogin({ request, username: 'owner', password: 'nope' });
    assert.equal(wrongPw.status, 401);
    assert.match(await wrongPw.text(), /Incorrect username, password/);
    const wrongUser = await submitLogin({ request, username: 'someone', password: PASSWORD });
    assert.equal(wrongUser.status, 401);
});

test('a tampered sign-in form is rejected', async () => {
    const { request } = await openLoginPage('tamper');
    const [payload, sig] = request.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    data.redirect_uri = 'https://evil.example/cb';
    const forged = `${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
    const res = await submitLogin({ request: forged, username: 'owner', password: PASSWORD });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /expired or was modified/);
});

test('invalid authorization requests get an error page, not a sign-in form', async () => {
    const res = await fetch(`${BASE}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code', client_id: 'test-client', redirect_uri: 'https://evil.example/?claude.ai'
    }));
    assert.equal(res.status, 400);
    assert.ok(!(await res.text()).includes('name="password"'));
});

test('sign-in + PKCE issues access and refresh tokens that work on /mcp', async () => {
    const code = await getCode('verifier-one');
    assert.match(code, /^[A-Za-z0-9_-]{43}$/, 'code is 32 random bytes, base64url');

    const res = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'verifier-one' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const tokens = await res.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    assert.ok(tokens.refresh_token);
    assert.ok(!tokens.access_token.includes(Buffer.from('test-client').toString('base64')), 'token does not embed base64 client id');
    assert.equal((await listTools(tokens.access_token)).status, 200);
    assert.equal((await listTools(tokens.refresh_token)).status, 401, 'refresh token is not an access token');

    const reuse = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'verifier-one' });
    assert.equal(reuse.status, 400, 'codes are single-use');
});

test('wrong PKCE verifier, missing verifier, or different redirect_uri is rejected', async () => {
    const wrong = await tokenRequest({ grant_type: 'authorization_code', code: await getCode('v-a'), redirect_uri: REDIRECT, code_verifier: 'not-it' });
    assert.equal(wrong.status, 400);
    const missing = await tokenRequest({ grant_type: 'authorization_code', code: await getCode('v-b'), redirect_uri: REDIRECT });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error_description, /code_verifier is required/);
    const redirect = await tokenRequest({ grant_type: 'authorization_code', code: await getCode('v-c'), redirect_uri: 'https://claude.com/other', code_verifier: 'v-c' });
    assert.equal(redirect.status, 400);
});

test('refresh tokens return new tokens and work only once', async () => {
    const first = await (await tokenRequest({ grant_type: 'authorization_code', code: await getCode('verifier-two'), redirect_uri: REDIRECT, code_verifier: 'verifier-two' })).json();

    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    assert.equal(refreshed.status, 200);
    const second = await refreshed.json();
    assert.notEqual(second.access_token, first.access_token);
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal((await listTools(second.access_token)).status, 200);

    const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error_description, /already been used/);

    const accessAsRefresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: second.access_token });
    assert.equal(accessAsRefresh.status, 400);
});

test('client credentials work only when ALLOW_CLIENT_CREDENTIALS=true', async () => {
    const enabled = await (await tokenRequest({ grant_type: 'client_credentials' })).json();
    assert.ok(enabled.access_token);
    assert.equal(enabled.refresh_token, undefined);

    const disabled = await tokenRequest({ grant_type: 'client_credentials' }, basic, MFA_BASE);
    assert.equal(disabled.status, 400);
    assert.equal((await disabled.json()).error, 'unsupported_grant_type');

    const meta = await (await fetch(`${MFA_BASE}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
});

test('wrong client secret is rejected', async () => {
    const res = await tokenRequest({ grant_type: 'client_credentials' }, 'Basic ' + Buffer.from('test-client:sec').toString('base64'));
    assert.equal(res.status, 401);
});

test('tampered and forged tokens are rejected', async () => {
    const { access_token } = await (await tokenRequest({ grant_type: 'client_credentials' })).json();
    const [v, payload, sig] = access_token.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    data.exp += 86400;
    const tampered = `${v}.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
    assert.equal((await listTools(tampered)).status, 401);
    assert.equal((await listTools('v1.abc.def')).status, 401);
    assert.equal((await listTools('not-a-token')).status, 401);
});

test('with MFA: the authenticator code is required, checked, and single-use', async () => {
    const page = await openLoginPage('mfa-1', MFA_BASE);
    assert.ok(page.html.includes('name="totp"'));

    const noCode = await submitLogin({ request: page.request, username: 'owner', password: PASSWORD }, MFA_BASE);
    assert.equal(noCode.status, 401);
    const valid = new Set([currentTotp(-1), currentTotp(0), currentTotp(1)]);
    const wrong = ['000000', '111111', '222222', '333333'].find(c => !valid.has(c));
    const wrongCode = await submitLogin({ request: page.request, username: 'owner', password: PASSWORD, totp: wrong }, MFA_BASE);
    assert.equal(wrongCode.status, 401);

    const code = currentTotp();
    const ok = await submitLogin({ request: page.request, username: 'owner', password: PASSWORD, totp: code }, MFA_BASE);
    assert.equal(ok.status, 302);

    const replay = await submitLogin({ request: page.request, username: 'owner', password: PASSWORD, totp: code }, MFA_BASE);
    assert.equal(replay.status, 401);
    assert.match(await replay.text(), /already used/);
});

test('5 failed sign-ins lock the address out', async () => {
    const { request } = await openLoginPage('lockout', MFA_BASE);
    for (let i = 0; i < 4; i++) {
        await submitLogin({ request, username: 'owner', password: 'wrong', totp: '123456' }, MFA_BASE);
    }
    // The MFA test above made 3 failed attempts; this makes at least 5 in total
    const blocked = await submitLogin({ request, username: 'owner', password: PASSWORD, totp: currentTotp(1) }, MFA_BASE);
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /Too many failed attempts/);
});

test('tokens expire, and changing the client secret invalidates them', async () => {
    process.env.OAUTH_CLIENT_ID = 'unit-client';
    process.env.OAUTH_CLIENT_SECRET = 'unit-secret';
    const server = new YahooMailMCPServer();

    const valid = server.issueToken('access', 'unit-client', 60);
    assert.ok(server.verifyToken(valid, 'access'));
    assert.equal(server.verifyToken(valid, 'refresh'), null);
    assert.equal(server.verifyToken(server.issueToken('access', 'unit-client', -1), 'access'), null);

    process.env.OAUTH_CLIENT_SECRET = 'rotated-secret';
    assert.equal(server.verifyToken(valid, 'access'), null);

    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
});

test('HTTP mode refuses to start without OAuth, without a sign-in, or with a plain-text password', async () => {
    const refuses = (env, pattern) => assert.rejects(startServer(env, PORT + 1), (err) => err.code === 1 && pattern.test(err.out));
    await refuses({}, /OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET/);
    await refuses({ ...oauthEnv }, /AUTH_USERNAME and AUTH_PASSWORD_HASH/);
    await refuses({ ...oauthEnv, AUTH_USERNAME: 'owner', AUTH_PASSWORD_HASH: 'hunter2' }, /not a plain password/);
    await refuses({ ...oauthEnv, ...loginEnv, AUTH_TOTP_SECRET: 'not base32!' }, /AUTH_TOTP_SECRET is not a valid/);

    const open = await startServer({ ALLOW_UNAUTHENTICATED: 'true' }, PORT + 2);
    open.kill();
});
