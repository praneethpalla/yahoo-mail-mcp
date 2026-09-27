// Offline tests for the shared IMAP connection: no network, no Yahoo logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { YahooMailMCPServer } from '../server.js';

function fakeServer({ failFirstLogin = false } = {}) {
    const server = new YahooMailMCPServer();
    const stats = { logins: 0, active: 0, maxActive: 0, order: [] };
    server.openImapConnection = async () => {
        stats.logins++;
        if (failFirstLogin && stats.logins === 1) throw new Error('LOGIN Server error');
        const conn = new EventEmitter();
        conn.state = 'authenticated';
        conn.getBoxes = (cb) => {
            stats.active++;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            setTimeout(() => { stats.active--; cb(null, { INBOX: { delimiter: '/', attribs: [], children: null } }); }, 20);
        };
        conn.end = () => { conn.state = 'disconnected'; conn.emit('end'); };
        return conn;
    };
    return { server, stats };
}

test('concurrent calls share one login and take turns', async () => {
    const { server, stats } = fakeServer();
    await Promise.all([server.listFolders(), server.listFolders(), server.listFolders()]);
    assert.equal(stats.logins, 1);
    assert.equal(stats.maxActive, 1);
    server.imapConn?.end();
});

test('reconnects after the connection drops', async () => {
    const { server, stats } = fakeServer();
    await server.listFolders();
    server.imapConn.emit('close');
    await server.listFolders();
    assert.equal(stats.logins, 2);
    server.imapConn?.end();
});

test('a failed login does not block later calls', async () => {
    const { server, stats } = fakeServer({ failFirstLogin: true });
    await assert.rejects(server.listFolders(), /LOGIN Server error/);
    await server.listFolders();
    assert.equal(stats.logins, 2);
    server.imapConn?.end();
});

test('logs out after the idle period', async () => {
    process.env.IMAP_IDLE_MS = '30';
    const { server } = fakeServer();
    await server.listFolders();
    const conn = server.imapConn;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(conn.state, 'disconnected');
    assert.equal(server.imapConn, null);
    delete process.env.IMAP_IDLE_MS;
});

test('calling end() twice releases only once', async () => {
    const { server, stats } = fakeServer();
    const lease = await server.createImapConnection();
    lease.end(); lease.end();
    await Promise.all([server.listFolders(), server.listFolders()]);
    assert.equal(stats.maxActive, 1);
    server.imapConn?.end();
});
