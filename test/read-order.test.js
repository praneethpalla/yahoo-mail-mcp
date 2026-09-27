// Offline test: read_email returns emails in request order. No network, no Yahoo logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { YahooMailMCPServer } from '../server.js';

test('read_email returns emails in the order the UIDs were requested', async () => {
    const server = new YahooMailMCPServer();
    const messages = new Map();
    for (const uid of [581098, 581266, 581362]) {
        messages.set(uid, await new MailComposer({ from: 'a@example.com', to: 'b@example.com', subject: `Subject ${uid}`, text: 'x' }).compile().build());
    }

    const conn = new EventEmitter();
    conn.state = 'authenticated';
    conn.openBox = (name, ro, cb) => cb(null, {});
    conn.fetch = () => {
        // Like a real IMAP server: messages come back in ascending UID order
        const f = new EventEmitter();
        setImmediate(() => {
            for (const uid of [...messages.keys()].sort((a, b) => a - b)) {
                const msg = new EventEmitter();
                f.emit('message', msg, uid);
                msg.emit('body', Readable.from([messages.get(uid)]), {});
                msg.emit('attributes', { uid, flags: [], size: 1 });
                msg.emit('end');
            }
            setTimeout(() => f.emit('end'), 5);
        });
        return f;
    };
    conn.end = () => {};
    server.openImapConnection = async () => conn;

    const result = await server.readEmail([581362, 581098, 581266]);
    const order = [...result.content[0].text.matchAll(/Email UID: (\d+)/g)].map(m => Number(m[1]));
    assert.deepEqual(order, [581362, 581098, 581266]);
});
