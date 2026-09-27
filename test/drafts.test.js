// Offline tests for the draft tools, using an in-memory fake IMAP server: no network, no Yahoo logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { YahooMailMCPServer } from '../server.js';

const ME = 'me@yahoo.com';

class FakeImap extends EventEmitter {
    constructor({ uidplus = true } = {}) {
        super();
        this.state = 'authenticated';
        this.uidplus = uidplus;
        this.boxes = { INBOX: new Map(), Draft: new Map(), Trash: new Map() };
        this.nextUid = 100;
        this.current = null;
    }
    serverSupports(cap) { return cap === 'UIDPLUS' && this.uidplus; }
    getBoxes(cb) {
        cb(null, {
            INBOX: { attribs: [], delimiter: '/', children: null },
            Draft: { attribs: ['\\Drafts'], special_use_attrib: '\\Drafts', delimiter: '/', children: null },
            Trash: { attribs: ['\\Trash'], delimiter: '/', children: null }
        });
    }
    openBox(name, readOnly, cb) {
        if (!this.boxes[name]) return cb(new Error(`Mailbox doesn't exist: ${name}`));
        this.current = name;
        cb(null, { name });
    }
    store(box, raw, flags = []) {
        const uid = this.nextUid++;
        this.boxes[box].set(uid, { raw: Buffer.from(raw), flags: [...flags] });
        return uid;
    }
    append(raw, { mailbox, flags }, cb) {
        const uid = this.store(mailbox, raw, flags);
        setImmediate(() => (this.uidplus ? cb(null, uid) : cb(null)));
    }
    fetch(source) {
        const uids = (Array.isArray(source) ? source : String(source).split(',')).map(Number);
        const f = new EventEmitter();
        setImmediate(() => {
            for (const uid of uids) {
                const entry = this.boxes[this.current].get(uid);
                if (!entry) continue;
                const msg = new EventEmitter();
                f.emit('message', msg, uid);
                msg.emit('body', Readable.from([entry.raw]), {});
                msg.emit('attributes', { uid, flags: entry.flags });
                setImmediate(() => msg.emit('end'));
            }
            setTimeout(() => f.emit('end'), 5);
        });
        return f;
    }
    search(criteria, cb) {
        const box = this.boxes[this.current];
        const [[key, ...args]] = criteria;
        let results = [];
        if (key === 'HEADER' && args[0] === 'MESSAGE-ID') {
            for (const [uid, e] of box) if (e.raw.toString().includes(args[1])) results.push(uid);
        } else if (key === 'UID') {
            results = args.map(Number).filter(uid => box.has(uid));
        }
        setImmediate(() => cb(null, results));
    }
    addFlags(uids, flag, cb) {
        for (const uid of uids) this.boxes[this.current].get(uid)?.flags.push(flag);
        setImmediate(() => cb(null));
    }
    expunge(uids, cb) {
        for (const uid of uids) {
            if (this.boxes[this.current].get(uid)?.flags.includes('\\Deleted')) this.boxes[this.current].delete(uid);
        }
        setImmediate(() => cb(null));
    }
    move(uids, dest, cb) {
        for (const uid of uids) {
            const e = this.boxes[this.current].get(uid);
            if (e) { this.boxes[this.current].delete(uid); this.store(dest, e.raw, e.flags); }
        }
        setImmediate(() => cb(null));
    }
    end() { this.state = 'disconnected'; this.emit('end'); }
}

function setup(opts) {
    process.env.YAHOO_EMAIL = ME;
    delete process.env.DRAFTS_FOLDER;
    const server = new YahooMailMCPServer();
    const imap = new FakeImap(opts);
    let logins = 0;
    server.openImapConnection = async () => { logins++; return imap; };
    return { server, imap, logins: () => logins };
}

const uidOf = (result) => Number(result.content[0].text.match(/Draft UID: (\d+)/)[1]);
const parseStored = (imap, box, uid) => simpleParser(imap.boxes[box].get(uid).raw);

async function tempFile(name, content) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yahoo-mcp-test-'));
    const file = path.join(dir, name);
    await fs.writeFile(file, content);
    return file;
}

async function seedOriginal(imap, fields) {
    const raw = await new MailComposer(fields).compile().build();
    return imap.store('INBOX', raw, ['\\Seen']);
}

test('create_draft saves a plain-text draft with bcc, attachment, and non-English text', async () => {
    const { server, imap } = setup();
    const file = await tempFile('report.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]));

    const result = await server.createDraft({
        to: ['Jane <jane@example.com>', 'bob@example.com'],
        cc: 'carol@example.com',
        bcc: ['secret@example.com'],
        subject: 'Café plans — 日本 trip',
        body: 'Hi Jane,\nПривет! Plans attached.\n',
        attachments: [file]
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /NOT sent/);
    assert.match(text, /Attachments: report\.pdf/);
    assert.match(text, /Format: plain text\n/);

    const uid = uidOf(result);
    const entry = imap.boxes.Draft.get(uid);
    assert.ok(entry.flags.includes('\\Draft'));

    const saved = await parseStored(imap, 'Draft', uid);
    assert.equal(saved.from.value[0].address, ME);
    assert.deepEqual(saved.to.value.map(a => a.address), ['jane@example.com', 'bob@example.com']);
    assert.equal(saved.cc.value[0].address, 'carol@example.com');
    assert.equal(saved.bcc.value[0].address, 'secret@example.com');
    assert.equal(saved.subject, 'Café plans — 日本 trip');
    assert.equal(saved.text.trim(), 'Hi Jane,\nПривет! Plans attached.');
    assert.equal(saved.html, false);
    assert.equal(saved.attachments.length, 1);
    assert.deepEqual([...saved.attachments[0].content], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
});

test('create_draft with html keeps both versions', async () => {
    const { server, imap } = setup();
    const result = await server.createDraft({ to: 'a@example.com', subject: 'Hi', body: 'plain', html: '<p><b>rich</b></p>' });
    const saved = await parseStored(imap, 'Draft', uidOf(result));
    assert.equal(saved.text.trim(), 'plain');
    assert.match(saved.html, /<b>rich<\/b>/);
    assert.match(result.content[0].text, /Format: plain text \+ HTML/);
});

test('create_draft rejects a missing recipient and an unreadable attachment', async () => {
    const { server } = setup();
    const noTo = await server.createDraft({ to: [], subject: 'x', body: 'y' });
    assert.equal(noTo.isError, true);
    await assert.rejects(
        server.createDraft({ to: 'a@example.com', subject: 'x', body: 'y', attachments: ['/nope/missing.pdf'] }),
        /Cannot read attachment "\/nope\/missing\.pdf"/
    );
});

test('create_reply_draft replies to the sender with threading headers and a quote', async () => {
    const { server, imap } = setup();
    const originalUid = await seedOriginal(imap, {
        from: 'Alice <alice@example.com>',
        to: `${ME}, dave@example.com`,
        cc: 'erin@example.com',
        subject: 'Budget for Q4',
        text: 'Can you review the numbers?\nThanks',
        messageId: '<orig-1@example.com>',
        references: ['<root-0@example.com>']
    });

    const result = await server.createReplyDraft({ uid: originalUid, body: 'Looks good to me.' });
    const saved = await parseStored(imap, 'Draft', uidOf(result));

    assert.deepEqual(saved.to.value.map(a => a.address), ['alice@example.com']);
    assert.equal(saved.cc, undefined);
    assert.equal(saved.subject, 'Re: Budget for Q4');
    assert.equal(saved.inReplyTo, '<orig-1@example.com>');
    assert.deepEqual(saved.references, ['<root-0@example.com>', '<orig-1@example.com>']);
    assert.match(saved.text, /^Looks good to me\./);
    assert.match(saved.text, /Alice <alice@example\.com> wrote:\n> Can you review the numbers\?\n> Thanks/);
});

test('create_reply_draft replyAll adds To/Cc, skips my own address, and does not double "Re:"', async () => {
    const { server, imap } = setup();
    const originalUid = await seedOriginal(imap, {
        from: 'alice@example.com',
        replyTo: 'team@example.com',
        to: `ME <${ME.toUpperCase()}>, dave@example.com`,
        cc: 'erin@example.com, alice@example.com',
        subject: 'RE: Budget',
        text: 'hello',
        messageId: '<orig-2@example.com>'
    });

    const result = await server.createReplyDraft({ uid: originalUid, body: 'Adding everyone.', replyAll: true, includeQuote: false });
    const saved = await parseStored(imap, 'Draft', uidOf(result));

    assert.deepEqual(saved.to.value.map(a => a.address), ['team@example.com', 'dave@example.com']);
    assert.deepEqual(saved.cc.value.map(a => a.address), ['erin@example.com', 'alice@example.com']);
    assert.equal(saved.subject, 'RE: Budget');
    assert.equal(saved.text.trim(), 'Adding everyone.');
});

test('create_reply_draft to my own sent message goes to its recipients', async () => {
    const { server, imap } = setup();
    const originalUid = await seedOriginal(imap, { from: ME, to: 'zoe@example.com', subject: 'Follow-up', text: 'x', messageId: '<orig-3@example.com>' });
    const result = await server.createReplyDraft({ uid: originalUid, body: 'Bumping this.' });
    const saved = await parseStored(imap, 'Draft', uidOf(result));
    assert.deepEqual(saved.to.value.map(a => a.address), ['zoe@example.com']);
});

test('update_draft changes only what is passed and removes the old version (UIDPLUS)', async () => {
    const { server, imap } = setup();
    const file = await tempFile('notes.txt', 'attached notes');
    const originalUid = await seedOriginal(imap, { from: 'alice@example.com', to: ME, subject: 'Plan', text: 'q', messageId: '<orig-4@example.com>' });

    const first = await server.createReplyDraft({ uid: originalUid, body: 'Draft v1', attachments: [file] });
    const uid1 = uidOf(first);
    await server.updateDraft({ uid: uid1, bcc: ['boss@example.com'] });
    const uid2 = [...imap.boxes.Draft.keys()].at(-1);

    const second = await server.updateDraft({ uid: uid2, body: 'Draft v2, shorter.' });
    const uid3 = uidOf(second);

    assert.match(second.content[0].text, new RegExp(`Previous version \\(UID ${uid2}\\) removed`));
    assert.deepEqual([...imap.boxes.Draft.keys()], [uid3]);
    assert.equal(imap.boxes.Trash.size, 0);

    const saved = await parseStored(imap, 'Draft', uid3);
    assert.equal(saved.text.trim(), 'Draft v2, shorter.');
    assert.equal(saved.subject, 'Re: Plan');
    assert.deepEqual(saved.to.value.map(a => a.address), ['alice@example.com']);
    assert.equal(saved.bcc.value[0].address, 'boss@example.com');
    assert.equal(saved.inReplyTo, '<orig-4@example.com>');
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.attachments[0].content.toString(), 'attached notes');
});

test('update_draft can add and remove attachments, and reports unknown names', async () => {
    const { server, imap } = setup();
    const a = await tempFile('a.txt', 'A');
    const b = await tempFile('b.txt', 'B');
    const uid1 = uidOf(await server.createDraft({ to: 'x@example.com', subject: 's', body: 'b', attachments: [a] }));

    const missing = await server.updateDraft({ uid: uid1, removeAttachments: ['nope.txt'] });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Current attachments: a\.txt/);
    assert.ok(imap.boxes.Draft.has(uid1), 'draft untouched after a failed update');

    const uid2 = uidOf(await server.updateDraft({ uid: uid1, removeAttachments: ['a.txt'], addAttachments: [b] }));
    const saved = await parseStored(imap, 'Draft', uid2);
    assert.deepEqual(saved.attachments.map(x => x.filename), ['b.txt']);
});

test('update_draft without UIDPLUS finds the new UID by Message-ID and moves the old draft to Trash', async () => {
    const { server, imap } = setup({ uidplus: false });
    const uid1 = uidOf(await server.createDraft({ to: 'x@example.com', subject: 's', body: 'v1' }));
    const result = await server.updateDraft({ uid: uid1, body: 'v2' });
    const uid2 = uidOf(result);

    assert.notEqual(uid2, uid1);
    assert.match(result.content[0].text, /moved to Trash/);
    assert.deepEqual([...imap.boxes.Draft.keys()], [uid2]);
    assert.equal(imap.boxes.Trash.size, 1);
});

test('update_draft of a UID that is not in Drafts fails without creating anything', async () => {
    const { server, imap } = setup();
    await assert.rejects(server.updateDraft({ uid: 999, body: 'x' }), /UID 999 not found/);
    assert.equal(imap.boxes.Draft.size, 0);
});

test('the whole flow uses one login and leaves the connection free', async () => {
    const { server, logins } = setup();
    const uid1 = uidOf(await server.createDraft({ to: 'x@example.com', subject: 's', body: 'v1' }));
    await server.updateDraft({ uid: uid1, body: 'v2' });
    await server.listFolders();  // would hang if a lease were never released
    assert.equal(logins(), 1);
});

test('DRAFTS_FOLDER overrides folder detection', async () => {
    const { server } = setup();
    process.env.DRAFTS_FOLDER = 'Draft';
    assert.equal(await server.findDraftsFolder(), 'Draft');
    delete process.env.DRAFTS_FOLDER;
});
