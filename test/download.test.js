// Offline tests for download hardening: ZIP inspection, size limit, private permissions,
// downloaded-file marking (macOS quarantine), and the after-save hook. No network, no logins.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { checkAttachment, inspectZip } from '../safety.js';
import { YahooMailMCPServer } from '../server.js';

afterEach(() => {
    delete process.env.ATTACHMENT_MAX_BYTES;
    delete process.env.ATTACHMENT_QUARANTINE;
    delete process.env.SAFETY_HOOKS_MODULE;
});

const tmp = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'yahoo-mcp-dl-'));
const hasZip = (() => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Build real archives with the system zip tool
function makeZips() {
    const dir = tmp();
    fsSync.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fsSync.writeFileSync(path.join(dir, 'invoice.pdf.exe'), 'MZ not really');
    fsSync.mkdirSync(path.join(dir, 'docs'));
    fsSync.writeFileSync(path.join(dir, 'docs', 'report.pdf'), '%PDF-1.7');
    const zip = (name, ...args) => {
        execFileSync('zip', ['-q', '-r', name, ...args], { cwd: dir });
        return fsSync.readFileSync(path.join(dir, name));
    };
    return {
        clean: zip('clean.zip', 'notes.txt', 'docs'),
        withProgram: zip('bad.zip', 'notes.txt', 'invoice.pdf.exe'),
        encrypted: (() => { execFileSync('zip', ['-q', '-P', 'secret123', 'enc.zip', 'notes.txt'], { cwd: dir }); return fsSync.readFileSync(path.join(dir, 'enc.zip')); })(),
        nested: zip('nested.zip', 'clean.zip')
    };
}

test('ZIP contents are listed without extracting', { skip: !hasZip && 'zip tool not available' }, () => {
    const { clean, encrypted } = makeZips();
    assert.deepEqual(inspectZip(clean).entries.map(e => e.name).sort(), ['docs/', 'docs/report.pdf', 'notes.txt']);
    assert.equal(inspectZip(encrypted).entries[0].encrypted, true);
    assert.match(inspectZip(Buffer.from('PK not a zip')).error, /no ZIP directory/);
});

test('a ZIP containing a program is blocked; encrypted and nested ZIPs get warnings', { skip: !hasZip && 'zip tool not available' }, () => {
    const zips = makeZips();
    assert.deepEqual(checkAttachment({ filename: 'photos.zip', content: zips.clean }), { block: null, warnings: [] });
    assert.match(checkAttachment({ filename: 'invoice.zip', content: zips.withProgram }).block, /contains a program or script \("invoice\.pdf\.exe"\)/);
    assert.match(checkAttachment({ filename: 'statement.zip', content: zips.encrypted }).warnings.join(), /password-protected/);
    assert.match(checkAttachment({ filename: 'files.zip', content: zips.nested }).warnings.join(), /contains another archive \("clean\.zip"\)/);
    // A ZIP renamed to .pdf is still inspected, because its contents start like a ZIP
    assert.match(checkAttachment({ filename: 'scan.pdf', content: zips.withProgram }).block, /contains a program or script/);
});

test('Office documents (which are ZIPs internally) are not treated as archives', () => {
    const docx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]);
    assert.deepEqual(checkAttachment({ filename: 'letter.docx', content: docx }), { block: null, warnings: [] });
});

test('attachments over the size limit are blocked', () => {
    process.env.ATTACHMENT_MAX_BYTES = String(2 * 1024 * 1024);
    assert.match(checkAttachment({ filename: 'huge.pdf', size: 5 * 1024 * 1024, content: Buffer.from('%PDF') }).block, /5 MB, over the 2 MB limit/);
    assert.equal(checkAttachment({ filename: 'small.pdf', size: 1024, content: Buffer.from('%PDF') }).block, null);
});

// --- End-to-end through download_attachments ---

async function serverWithAttachment(attachments) {
    const raw = await new MailComposer({ from: 'a@example.com', to: 'me@example.com', subject: 'Files', text: 'attached', attachments }).compile().build();
    const server = new YahooMailMCPServer();
    const conn = new EventEmitter();
    conn.state = 'authenticated';
    conn.openBox = (name, ro, cb) => cb(null, {});
    conn.fetch = () => {
        const f = new EventEmitter();
        setImmediate(async () => {
            const msg = new EventEmitter();
            f.emit('message', msg, 1);
            const body = Readable.from([raw]);
            msg.emit('body', body, {});
            msg.emit('attributes', { uid: 3, flags: [], size: raw.length });
            await new Promise(r => body.on('end', r));
            msg.emit('end');
            setTimeout(() => f.emit('end'), 5);
        });
        return f;
    };
    conn.end = () => {};
    server.openImapConnection = async () => conn;
    return server;
}

const quarantineOf = (file) => {
    try { return execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file]).toString().trim(); } catch { return null; }
};

test('saved files are private, not executable, and marked as downloaded', async () => {
    const server = await serverWithAttachment([{ filename: 'report.pdf', content: Buffer.from('%PDF-1.7 hello') }]);
    const dir = path.join(tmp(), 'new-folder');
    const result = await server.downloadAttachments(3, 'INBOX', null, dir);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /private to you, marked as downloaded/);

    const file = path.join(dir, 'report.pdf');
    assert.equal(await fs.readFile(file, 'utf8'), '%PDF-1.7 hello');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'readable and writable by the owner only');
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, 'a newly created folder is private');
    if (process.platform === 'darwin') {
        assert.match(quarantineOf(file), /^0081;[0-9a-f]+;yahoo-mail-mcp;$/, 'macOS quarantine tag, as browsers set');
    }
});

test('ATTACHMENT_QUARANTINE=false skips the download tag', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
    process.env.ATTACHMENT_QUARANTINE = 'false';
    const server = await serverWithAttachment([{ filename: 'plain.txt', content: Buffer.from('hi') }]);
    const dir = tmp();
    await server.downloadAttachments(3, 'INBOX', null, dir);
    assert.equal(quarantineOf(path.join(dir, 'plain.txt')), null);
});

test('an after-save hook (e.g. antivirus) can reject a saved file, which is then deleted', async () => {
    const hooksDir = tmp();
    const hooks = path.join(hooksDir, 'av.mjs');
    await fs.writeFile(hooks, `import fs from 'node:fs/promises';
        export async function afterSaveAttachment(ctx) {
            const text = await fs.readFile(ctx.filePath, 'utf8');
            return text.includes('EICAR') ? { block: 'Antivirus found a test signature in ' + ctx.filename } : { warnings: ['scanned: clean'] };
        }`);
    process.env.SAFETY_HOOKS_MODULE = hooks;

    const server = await serverWithAttachment([
        { filename: 'clean.txt', content: Buffer.from('all good') },
        { filename: 'infected.txt', content: Buffer.from('X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE') }
    ]);
    const dir = tmp();
    const result = await server.downloadAttachments(3, 'INBOX', null, dir);
    const text = result.content[0].text;
    assert.match(text, /Saved 1 attachment/);
    assert.match(text, /Antivirus found a test signature in infected\.txt/);
    assert.match(text, /scanned: clean/);
    assert.deepEqual(await fs.readdir(dir), ['clean.txt'], 'the rejected file was removed');
});
