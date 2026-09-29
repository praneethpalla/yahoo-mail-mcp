// Offline tests for the safety hooks, using made-up scam emails and attachments. No network, no logins.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {
    paymentWarnings, senderWarnings, checkAttachment, resolveDraftAttachment, runHooks
} from '../safety.js';
import { YahooMailMCPServer } from '../server.js';

afterEach(() => {
    delete process.env.ATTACHMENT_ALLOW_EXTENSIONS;
    delete process.env.DRAFT_ATTACHMENT_DIRS;
    delete process.env.SAFETY_HOOKS_MODULE;
});

const tmp = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'yahoo-mcp-safety-'));

test('payment red flags are detected in scam-style messages', () => {
    const cases = {
        'Our bank details have changed. Please pay the invoice to our new account.': /change of bank or payment details/,
        'Please remit to IBAN GB82 WEST 1234 5698 7654 32 today.': /an IBAN/,
        'Wire transfer to account number: 1234 5678 9012': /bank account number.*wire or bank transfer|wire or bank transfer/,
        'I need you to buy 5 Apple gift cards for a client.': /gift cards/,
        'Send the payment to our ETH wallet 0x52908400098527886E0F7030069857D2E4169EE7': /cryptocurrency/,
        'FINAL NOTICE: invoice overdue, pay immediately to avoid suspension': /urgent pressure to pay/
    };
    for (const [text, expected] of Object.entries(cases)) {
        const [warning] = paymentWarnings(text);
        assert.match(warning || '', expected, text);
        assert.match(warning, /Verify any payment request through a contact you already trust/);
    }
});

test('ordinary messages do not trigger payment warnings', () => {
    for (const text of [
        'Thanks for your payment last month. See you at the offsite!',
        'Your order has shipped. Tracking: 1Z999AA10123456784, ref 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
        'Lunch on Friday at 12?'
    ]) {
        assert.deepEqual(paymentWarnings(text), [], text);
    }
});

test('Reply-To redirects and display-name spoofing are flagged', () => {
    const warnings = senderWarnings({
        from: [{ name: 'support@paypal.com', address: 'billing@evil.example' }],
        replyTo: [{ address: 'collect@evil2.example' }]
    });
    assert.match(warnings[0], /Reply-To \(collect@evil2\.example\) differs from the sender \(billing@evil\.example\)/);
    assert.match(warnings[1], /display name shows "support@paypal\.com".*actually comes from "billing@evil\.example"/);
    assert.deepEqual(senderWarnings({ from: [{ name: 'Alice', address: 'alice@example.com' }], replyTo: [{ address: 'ALICE@example.com' }] }), []);
});

test('programs and scripts are blocked by name, by declared type, and by contents', () => {
    assert.match(checkAttachment({ filename: 'setup.exe', content: Buffer.from('x') }).block, /blocked file type \(\.exe\)/);
    assert.match(checkAttachment({ filename: 'invoice.pdf', content: Buffer.from('MZ\x90\x00rest') }).block, /Windows program \(MZ header\) disguised as \.pdf/);
    assert.match(checkAttachment({ filename: 'photo.jpg', content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]) }).block, /Linux program/);
    assert.match(checkAttachment({ filename: 'doc.pdf', content: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7]) }).block, /macOS program/);
    assert.match(checkAttachment({ filename: 'notes.txt', content: Buffer.from('#!/bin/sh\nrm -rf ~') }).block, /script/);
    assert.match(checkAttachment({ filename: 'report.pdf', contentType: 'application/x-msdownload', content: Buffer.from('%PDF') }).block, /declared as a program/);
    assert.match(checkAttachment({ filename: 'Installer.DMG', content: Buffer.from('x') }).block, /\.dmg/);
    assert.match(checkAttachment({ filename: 'run.js.', content: Buffer.from('x') }).block, /\.js/, 'trailing dots cannot hide the type');
});

test('risky but legitimate files are saved with warnings; normal files pass quietly', () => {
    assert.match(checkAttachment({ filename: 'budget.xlsm', content: Buffer.from('PK') }).warnings[0], /can contain macros/);
    const zip = checkAttachment({ filename: 'invoice.pdf.zip', content: Buffer.from('PK') });
    assert.equal(zip.block, null);
    assert.ok(zip.warnings.some(w => /double extension/.test(w)) && zip.warnings.some(w => /archive/.test(w)));
    assert.match(checkAttachment({ filename: 'login.html', content: Buffer.from('<form>') }).warnings[0], /fake sign-in forms/);
    assert.deepEqual(checkAttachment({ filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7') }), { block: null, warnings: [] });
});

test('only ATTACHMENT_ALLOW_EXTENSIONS (an env setting, not a tool argument) can allow a blocked type', () => {
    process.env.ATTACHMENT_ALLOW_EXTENSIONS = '.sh, ps1';
    assert.equal(checkAttachment({ filename: 'deploy.sh', content: Buffer.from('#!/bin/sh') }).block, null);
    assert.ok(checkAttachment({ filename: 'x.exe', content: Buffer.from('x') }).block);
});

test('draft attachments must come from the allowed folders (paths, "..", and symlinks)', async () => {
    const allowed = tmp();
    const outside = tmp();
    await fs.writeFile(path.join(allowed, 'ok.pdf'), '%PDF');
    await fs.writeFile(path.join(outside, 'secret.key'), 'SECRET');
    await fs.symlink(path.join(outside, 'secret.key'), path.join(allowed, 'innocent.pdf'));
    process.env.DRAFT_ATTACHMENT_DIRS = allowed;

    assert.equal(await resolveDraftAttachment(path.join(allowed, 'ok.pdf')), await fs.realpath(path.join(allowed, 'ok.pdf')));
    await assert.rejects(resolveDraftAttachment(path.join(outside, 'secret.key')), /Blocked: draft attachments can only come from/);
    await assert.rejects(resolveDraftAttachment(path.join(allowed, '..', path.basename(outside), 'secret.key')), /Blocked/);
    await assert.rejects(resolveDraftAttachment(path.join(allowed, 'innocent.pdf')), /Blocked/, 'a symlink pointing outside is refused');
    await assert.rejects(resolveDraftAttachment(path.join(allowed, 'missing.pdf')), /Cannot read attachment/);
});

test('custom hooks can add warnings and blocks, and a failing custom hook blocks (fails closed)', async () => {
    const dir = tmp();
    const good = path.join(dir, 'hooks.mjs');
    await fs.writeFile(good, `export function beforeDraft(ctx) {
        return /wire/i.test(ctx.subject) ? { block: 'no wire-transfer drafts' } : { warnings: ['custom check ran'] };
    }`);
    process.env.SAFETY_HOOKS_MODULE = good;
    assert.deepEqual(await runHooks('beforeDraft', { subject: 'Wire details', body: '' }), { warnings: [], block: 'no wire-transfer drafts' });
    assert.deepEqual((await runHooks('beforeDraft', { subject: 'Lunch', body: '' })).warnings, ['custom check ran']);

    const broken = path.join(dir, 'broken.mjs');
    await fs.writeFile(broken, `export function beforeSaveAttachment() { throw new Error('bug in my hook'); }`);
    process.env.SAFETY_HOOKS_MODULE = broken;
    const result = await runHooks('beforeSaveAttachment', { filename: 'report.pdf', content: Buffer.from('%PDF') });
    assert.match(result.block, /Custom safety hook "beforeSaveAttachment" failed: bug in my hook/);
});

// --- End-to-end through the server, with a made-up mailbox ---

function serverWithMessages(messages) {
    process.env.YAHOO_EMAIL = 'me@example.com';
    const server = new YahooMailMCPServer();
    const appended = [];
    const conn = new EventEmitter();
    conn.state = 'authenticated';
    conn.openBox = (name, ro, cb) => cb(null, {});
    conn.getBoxes = (cb) => cb(null, { Draft: { attribs: ['\\Drafts'], special_use_attrib: '\\Drafts', delimiter: '/' } });
    conn.append = (raw, opts, cb) => { appended.push(raw); cb(null, 900 + appended.length); };
    conn.fetch = (source) => {
        const uids = (Array.isArray(source) ? source : String(source).split(',')).map(Number);
        const f = new EventEmitter();
        setImmediate(async () => {
            for (const uid of uids) {
                const raw = messages[uid];
                if (!raw) continue;
                const msg = new EventEmitter();
                f.emit('message', msg, uid);
                const body = Readable.from([raw]);
                msg.emit('body', body, {});
                msg.emit('attributes', { uid, flags: [], size: raw.length });
                await new Promise(r => body.on('end', r));
                msg.emit('end');
            }
            setTimeout(() => f.emit('end'), 5);
        });
        return f;
    };
    conn.end = () => {};
    server.openImapConnection = async () => conn;
    return { server, appended };
}

const build = (fields) => new MailComposer(fields).compile().build();

test('read_email shows server warnings outside the untrusted block for a payment scam', async () => {
    const raw = await build({
        from: '"accounts@supplier.com" <billing@evil.example>',
        replyTo: 'collect@evil2.example',
        to: 'me@example.com',
        subject: 'URGENT: invoice overdue',
        text: 'Our bank details have changed. Pay immediately to IBAN GB82 WEST 1234 5698 7654 32.'
    });
    const { server } = serverWithMessages({ 5: raw });
    const text = (await server.readEmail([5])).content[0].text;
    const block = text.search(/<untrusted-content source=/);
    for (const pattern of [/⚠️ Server safety check: Reply-To/, /⚠️ Server safety check: The sender's display name/, /⚠️ Server safety check: Payment red flags/]) {
        const m = text.match(pattern);
        assert.ok(m, `missing ${pattern}`);
        assert.ok(m.index < block, 'warnings appear before (outside) the untrusted block');
    }
});

test('download_attachments refuses a disguised program and writes nothing', async () => {
    const raw = await build({
        from: 'a@example.com', to: 'me@example.com', subject: 'Invoice', text: 'see attached',
        attachments: [{ filename: 'invoice.pdf', content: Buffer.from('MZ\x90\x00 not really a pdf') }]
    });
    const { server } = serverWithMessages({ 6: raw });
    const dir = tmp();
    const result = await server.downloadAttachments(6, 'INBOX', null, dir);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Blocked by the server's safety check[\s\S]*disguised as \.pdf/);
    assert.deepEqual(await fs.readdir(dir), []);
});

test('create_draft cannot attach files from outside the allowed folder', async () => {
    const outside = tmp();
    await fs.writeFile(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    process.env.DRAFT_ATTACHMENT_DIRS = tmp();
    const { server, appended } = serverWithMessages({});
    await assert.rejects(
        server.createDraft({ to: ['billing@attacker.example'], subject: 'x', body: 'y', attachments: [path.join(outside, 'id_rsa')] }),
        /Blocked: draft attachments can only come from/
    );
    assert.equal(appended.length, 0, 'no draft was saved');
});

test('a reply to a redirected Reply-To carries a warning in the draft result', async () => {
    const raw = await build({ from: 'boss@company.example', replyTo: 'boss.private@evil.example', to: 'me@example.com', subject: 'Quick favour', text: 'Can you help?' });
    const { server } = serverWithMessages({ 8: raw });
    const result = await server.createReplyDraft({ uid: 8, body: 'Sure, what do you need?' });
    assert.match(result.content[0].text, /⚠️ Server safety check: This reply goes to boss\.private@evil\.example \(the email's Reply-To\), not to the sender boss@company\.example/);
});
