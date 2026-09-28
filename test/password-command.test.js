// Offline tests for YAHOO_APP_PASSWORD_COMMAND (reading the app password from a password store).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { YahooMailMCPServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
    delete process.env.YAHOO_APP_PASSWORD_COMMAND;
    delete process.env.YAHOO_APP_PASSWORD;
});

test('uses the command output (trailing newline removed) and runs it only once', async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwcmd-')), 'runs');
    process.env.YAHOO_APP_PASSWORD_COMMAND = `echo run >> "${counter}"; printf 'from-store\\n'`;
    const server = new YahooMailMCPServer();
    assert.equal(await server.getAppPassword(), 'from-store');
    assert.equal(await server.getAppPassword(), 'from-store');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'cached after the first read');
});

test('there is no plain-text fallback: without a command there is no password', async () => {
    process.env.YAHOO_APP_PASSWORD = 'plain-text';
    assert.equal(await new YahooMailMCPServer().getAppPassword(), null);
});

for (const mode of ['stdio', 'http']) {
    test(`the server refuses to start (${mode}) when a plain YAHOO_APP_PASSWORD is set`, async () => {
        const proc = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', TRANSPORT_MODE: mode, YAHOO_EMAIL: 'x@example.invalid', YAHOO_APP_PASSWORD: 'Zq9-dummy-secret', ALLOW_UNAUTHENTICATED: 'true', PORT: '0' }
        });
        let err = '';
        proc.stderr.on('data', d => { err += d; });
        const code = await new Promise(resolve => proc.on('exit', resolve));
        assert.equal(code, 1);
        assert.match(err, /Refusing to start: YAHOO_APP_PASSWORD is set/);
        assert.ok(!err.includes('Zq9-dummy-secret'), 'the password value is never printed');
    });
}

test('a failing command gives an error that does not include its output', async () => {
    process.env.YAHOO_APP_PASSWORD_COMMAND = 'echo leaked-secret; echo more-secret >&2; exit 3';
    await assert.rejects(new YahooMailMCPServer().getAppPassword(), (err) => {
        assert.match(err.message, /failed \(exit code 3\)/);
        assert.ok(!err.message.includes('secret'));
        return true;
    });
});

test('empty command output is an error', async () => {
    process.env.YAHOO_APP_PASSWORD_COMMAND = 'printf ""';
    await assert.rejects(new YahooMailMCPServer().getAppPassword(), /printed nothing/);
});

test('the IMAP login uses the password from the command', async () => {
    process.env.YAHOO_APP_PASSWORD_COMMAND = "printf 'store-pw'";
    process.env.YAHOO_EMAIL = 'someone@example.invalid';
    const server = new YahooMailMCPServer();
    let seen;
    const original = server.getAppPassword.bind(server);
    server.getAppPassword = async () => (seen = await original());
    // Stop before any network use: fail the connection setup right after the password is read
    const openBox = server.openImapConnection.bind(server);
    const Imap = (await import('imap')).default;
    const connect = Imap.prototype.connect;
    Imap.prototype.connect = function () { this.emit('error', new Error('offline test: no network')); };
    try {
        await assert.rejects(openBox(), /offline test/);
        assert.equal(seen, 'store-pw');
    } finally {
        Imap.prototype.connect = connect;
        delete process.env.YAHOO_EMAIL;
    }
});
