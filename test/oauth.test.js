// Offline tests for OAuth: signed expiring tokens, refresh rotation, auth codes, and startup safety.
// Uses a local server with dummy credentials; nothing connects to Yahoo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YahooMailMCPServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const baseEnv = {
    PATH: process.env.PATH,
    ENV_FILE: '/dev/null',
    TRANSPORT_MODE: 'http',
    YAHOO_EMAIL: 'dummy@example.invalid',
    YAHOO_APP_PASSWORD: 'dummy'
};
let child;

function startServer(env, port) {
    const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...baseEnv, PORT: String(port), ...env } });
    let out = '';
    const ready = new Promise((resolve, reject) => {
        proc.stderr.on('data', d => { out += d; if (out.includes('running on port')) resolve(proc); });
        proc.on('exit', code => reject(Object.assign(new Error(`exited ${code}`), { code, out })));
    });
    return ready;
}

before(async () => {
    child = await startServer({ OAUTH_CLIENT_ID: 'test-client', OAUTH_CLIENT_SECRET: 'sec:ret' }, PORT);
});
after(() => child?.kill());

const basic = 'Basic ' + Buffer.from('test-client:sec:ret').toString('base64');
const tokenRequest = (body, auth = basic) => fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body)
});
const listTools = (accessToken) => fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});

async function getCode(verifier, redirect = REDIRECT) {
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const res = await fetch(`${BASE}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code', client_id: 'test-client', redirect_uri: redirect,
        code_challenge: challenge, code_challenge_method: 'S256', state: 's1'
    }), { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('state'), 's1');
    return location.searchParams.get('code');
}

test('authorization code + PKCE issues access and refresh tokens that work on /mcp', async () => {
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

    // The refresh token can't be used as an access token
    assert.equal((await listTools(tokens.refresh_token)).status, 401);

    // Codes are single-use
    const reuse = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'verifier-one' });
    assert.equal(reuse.status, 400);
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
    const code = await getCode('verifier-two');
    const first = await (await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'verifier-two' })).json();

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

test('client credentials issue an access token without a refresh token', async () => {
    const res = await tokenRequest({ grant_type: 'client_credentials' });
    const body = await res.json();
    assert.ok(body.access_token);
    assert.equal(body.refresh_token, undefined);
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

test('tokens expire, and changing the client secret invalidates them', async () => {
    process.env.OAUTH_CLIENT_ID = 'unit-client';
    process.env.OAUTH_CLIENT_SECRET = 'unit-secret';
    const server = new YahooMailMCPServer();

    const valid = server.issueToken('access', 'unit-client', 60);
    assert.ok(server.verifyToken(valid, 'access'));
    assert.equal(server.verifyToken(valid, 'refresh'), null);

    const expired = server.issueToken('access', 'unit-client', -1);
    assert.equal(server.verifyToken(expired, 'access'), null);

    process.env.OAUTH_CLIENT_SECRET = 'rotated-secret';
    assert.equal(server.verifyToken(valid, 'access'), null);

    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
});

test('HTTP mode refuses to start without OAuth unless ALLOW_UNAUTHENTICATED=true', async () => {
    await assert.rejects(startServer({}, PORT + 1), (err) => err.code === 1 && /Refusing to start/.test(err.out));
    const open = await startServer({ ALLOW_UNAUTHENTICATED: 'true' }, PORT + 2);
    open.kill();
});
