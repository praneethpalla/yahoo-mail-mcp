// Offline tests for bulk flag/move operations: no network, no Yahoo logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { YahooMailMCPServer } from '../server.js';

function setup({ bulkFails = false } = {}) {
    const server = new YahooMailMCPServer();
    const calls = [];
    const existing = new Set([10, 11, 12]);
    const conn = new EventEmitter();
    conn.state = 'authenticated';
    conn.openBox = (name, ro, cb) => cb(null, {});
    conn.search = (criteria, cb) => {
        calls.push(['search', criteria]);
        const [[, ...uids]] = criteria;
        cb(null, uids.filter(u => existing.has(u)));
    };
    conn.addFlags = (source, flag, cb) => {
        calls.push(['addFlags', source]);
        if (bulkFails && Array.isArray(source) && source.length > 1) return cb(new Error('bulk not supported'));
        cb(null);
    };
    conn.move = (source, dest, cb) => { calls.push(['move', source]); cb(null); };
    conn.end = () => {};
    server.openImapConnection = async () => conn;
    return { server, calls };
}

test('bulk flag sends one command for all existing UIDs and reports missing ones', async () => {
    const { server, calls } = setup();
    const result = await server.flagEmails([10, 11, 99, 12]);
    assert.deepEqual(calls[0], ['search', [['UID', 10, 11, 99, 12]]]);
    assert.deepEqual(calls.filter(c => c[0] === 'addFlags'), [['addFlags', [10, 11, 12]]]);
    assert.match(result.content[0].text, /Successfully flagged 3 of 4 email\(s\)\. Successful: 10, 11, 12\. Failed: 99/);
});

test('bulk falls back to one UID at a time when the bulk command fails', async () => {
    const { server, calls } = setup({ bulkFails: true });
    const result = await server.markAsRead([10, 11]);
    assert.deepEqual(calls.filter(c => c[0] === 'addFlags').map(c => c[1]), [[10, 11], '10', '11']);
    assert.match(result.content[0].text, /Successfully marked as read 2 email\(s\)/);
});

test('all-missing UIDs return an error without modifying anything', async () => {
    const { server, calls } = setup();
    await assert.rejects(server.archiveEmails([98, 99]), /None of the 2 email\(s\) could be archived/);
    assert.equal(calls.filter(c => c[0] === 'move').length, 0);
});

test('delete stays one email at a time (no bulk lookup)', async () => {
    const { server, calls } = setup();
    await server.deleteEmails([10, 11]);
    assert.equal(calls.filter(c => c[0] === 'search').length, 0);
    assert.deepEqual(calls.filter(c => c[0] === 'move').map(c => c[1]), ['10', '11']);
});
