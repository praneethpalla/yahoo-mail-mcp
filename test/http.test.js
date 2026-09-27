// Offline tests for the HTTP transports (Streamable HTTP + legacy SSE) and OAuth checks.
// Starts the server on a local port with dummy credentials; no request reaches IMAP/Yahoo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hashPassword } from '../auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 38000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ACCEPT = 'application/json, text/event-stream';
let child;
let stderr = '';
let token;

before(async () => {
    child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            PATH: process.env.PATH,
            ENV_FILE: '/dev/null',  // ignore the real .env
            TRANSPORT_MODE: 'http',
            PORT: String(PORT),
            YAHOO_EMAIL: 'dummy@example.invalid',
            YAHOO_APP_PASSWORD: 'dummy',
            OAUTH_CLIENT_ID: 'test-client',
            OAUTH_CLIENT_SECRET: 'test-secret',
            OAUTH_REDIRECT_HOSTS: 'claude.ai,claude.com,chatgpt.com',
            AUTH_USERNAME: 'owner',
            AUTH_PASSWORD_HASH: hashPassword('a long test password'),
            ALLOW_CLIENT_CREDENTIALS: 'true'
        }
    });
    child.stderr.on('data', d => { stderr += d; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr}`)), 10000);
        child.stderr.on('data', () => {
            if (stderr.includes('running on port')) { clearTimeout(timer); resolve(); }
        });
    });

    const res = await fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'test-client', client_secret: 'test-secret' })
    });
    token = (await res.json()).access_token;
});

after(() => child?.kill());

const rpc = (body, headers = {}) => fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body)
});

test('/mcp without a token is rejected with a pointer to the OAuth metadata', async () => {
    const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata="https:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('initialize works statelessly (JSON reply, no session id)', async () => {
    const res = await rpc({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('mcp-session-id'), null);
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'yahoo-mail-mcp');
});

test('tools/list returns all tools', async () => {
    const body = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = body.result.tools.map(t => t.name);
    for (const name of ['list_emails', 'read_email', 'download_attachments', 'create_draft', 'create_reply_draft', 'update_draft']) {
        assert.ok(names.includes(name), `missing ${name}`);
    }
});

test('tool errors come back with isError, and parallel requests work', async () => {
    const [a, b] = await Promise.all([
        rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_emails', arguments: { count: 99 } } }),
        rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_draft', arguments: { to: [], subject: 's', body: 'b' } } })
    ]);
    const ra = (await a.json()).result;
    const rb = (await b.json()).result;
    assert.equal(ra.isError, true);
    assert.match(ra.content[0].text, /count cannot exceed 50/);
    assert.equal(rb.isError, true);
    assert.match(rb.content[0].text, /at least one "to" address/);
});

test('GET and DELETE on /mcp return 405 in stateless mode', async () => {
    for (const method of ['GET', 'DELETE']) {
        const res = await fetch(`${BASE}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
        assert.equal(res.status, 405, method);
    }
});

test('protected resource metadata exists for /mcp and /mcp/sse', async () => {
    const mcp = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.match(mcp.resource, /\/mcp$/);
    const sse = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/sse`)).json();
    assert.match(sse.resource, /\/mcp\/sse$/);
});

test('OAuth redirect_uri is checked by exact hostname', async () => {
    const authorize = (redirect) => fetch(`${BASE}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code', client_id: 'test-client', redirect_uri: redirect, state: 'x'
    }), { redirect: 'manual' });

    for (const good of ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'http://localhost:6274/callback']) {
        assert.equal((await authorize(good)).status, 200, good);  // sign-in page
    }
    for (const bad of ['https://evil.example/?claude.ai', 'https://claude.ai.evil.example/cb', 'http://claude.ai/cb', 'not a url']) {
        assert.equal((await authorize(bad)).status, 400, bad);
    }
});

test('legacy SSE endpoint still opens an event stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/mcp/sse`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: endpoint/);
    controller.abort();
});

test('the official MCP SDK client can connect, list tools, and call a tool', async () => {
    const client = new Client({ name: 'sdk-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'update_draft'));
    const result = await client.callTool({ name: 'search_emails', arguments: { query: '', dateFrom: 'last week' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid dateFrom format/);
    await client.close();
});

test('no request tried to connect to IMAP', () => {
    assert.doesNotMatch(stderr, /\[IMAP\]/);
});
