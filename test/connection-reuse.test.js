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

test('a stuck call past the lease timeout gets its connection closed, not shared', async () => {
    process.env.IMAP_LEASE_TIMEOUT_MS = '30';
    const { server, stats } = fakeServer();
    const stuck = await server.createImapConnection();  // never calls end()
    const stuckConn = server.imapConn;
    let destroyed = false;
    stuckConn.destroy = () => { destroyed = true; stuckConn.state = 'disconnected'; };

    await server.listFolders();  // waits for the timeout, then must get a new connection
    assert.equal(destroyed, true, 'the stuck connection was closed');
    assert.equal(stats.logins, 2, 'the next call logged in fresh instead of reusing it');
    assert.notEqual(server.imapConn, stuckConn);
    assert.throws(() => stuck.getBoxes(() => {}), /used after it was released/);

    delete process.env.IMAP_LEASE_TIMEOUT_MS;
    server.imapConn?.end();
});

test('a released handle refuses further use, so it cannot touch another call\'s folder', async () => {
    const { server } = fakeServer();
    const lease = await server.createImapConnection();
    lease.end();
    assert.throws(() => lease.getBoxes(() => {}), /used after it was released \(getBoxes\)/);
    await server.listFolders();  // the next call still works normally
    server.imapConn?.end();
});
