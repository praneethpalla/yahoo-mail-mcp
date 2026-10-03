/**
 * Safety hooks: checks that run automatically at three points and either warn or block.
 *
 *   readEmail            - every email read: payment red flags, Reply-To mismatch, sender spoofing
 *   beforeSaveAttachment - before an attachment is written to disk: blocks executables and scripts
 *                          (by extension and by file contents), oversized files, and ZIPs containing
 *                          programs; warns about macros, encrypted or nested archives, HTML
 *   afterSaveAttachment  - after a file is saved (custom hooks only, e.g. an antivirus scan of
 *                          ctx.filePath); a block deletes the file
 *   beforeDraft          - before a draft is saved: attachments only from allowed folders,
 *                          warnings for Reply-To mismatch and payment details
 *
 * Warnings are produced by the server and shown outside the untrusted-content block, so an email
 * can't fake or hide them. Blocks can only be relaxed through environment settings, never through
 * tool arguments, so a misled agent can't switch them off.
 *
 * Custom hooks: set SAFETY_HOOKS_MODULE to a JavaScript module that exports any of
 * readEmail(ctx), beforeSaveAttachment(ctx), beforeDraft(ctx), each returning
 * { warnings?: string[], block?: string } (or a promise of it).
 */

import fs from 'fs/promises';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Payment red flags
// ---------------------------------------------------------------------------

const PAYMENT_PATTERNS = [
    { label: 'a change of bank or payment details', re: /\b(new|updated?|changed?|different)\s+(bank(ing)?|account|payment|remittance|wire)\s+(details|information|info|instructions|account)\b|\b(bank(ing)?|account|payment)\s+(details|information)\s+(have|has)\s+(changed|been updated)\b/i },
    { label: 'an IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/ },
    { label: 'a SWIFT/BIC, routing, or sort code', re: /\b(swift|bic|aba|routing|sort\s*code|transit)\b[^\n]{0,20}?\b[A-Z0-9-]{6,11}\b/i },
    { label: 'a bank account number', re: /\b(account|acct|a\/c)\s*(no\.?|number|#)?\s*[:#]?\s*\d[\d\s-]{6,}\d\b/i },
    { label: 'a wire or bank transfer request', re: /\b(wire|bank|telegraphic|swift)\s+transfer\b|\bremit(tance)?\b|\bpay\s+(to|into)\s+(the\s+)?(following|this|new)\b/i },
    { label: 'gift cards', re: /\bgift\s*cards?\b|\b(itunes|google\s*play|steam|amazon)\s+(gift\s+)?cards?\b/i },
    { label: 'a cryptocurrency address or crypto payment', re: /\b(bc1[a-z0-9]{25,62}|0x[a-fA-F0-9]{40})\b|\b(bitcoin|btc|ethereum|eth|usdt|crypto)\b[^\n]{0,40}\b(wallet|address|payment|send)\b/i }
];
const URGENCY = /\b(urgent(ly)?|immediately|asap|today|tonight|within\s+\d+\s+hours?|overdue|final\s+notice|past\s+due|act\s+now|avoid\s+(suspension|penalt)|will\s+be\s+(blocked|suspended|deactivated|disconnected|frozen|closed))/i;
const PAYMENT_WORDS = /\b(pay|payment|invoice|transfer|wire|remit|refund|deposit)\b/i;
// Indian rupee amounts: ₹ 1,200 / Rs. 1200 / INR 1,200.50
const INR_AMOUNT = /(₹|\bRs\.?|\bINR)\s?\d[\d,]*(\.\d+)?/i;

// India-specific patterns, written to avoid firing on routine bank and fund emails
const UPI_HANDLES = 'ok(axis|hdfcbank|icici|sbi)|ybl|ibl|axl|paytm|upi|apl|yapl|pt(yes|axis|hdfc|sbi)|axisbank|icici|sbi|hdfcbank|kotak|freecharge|airtel|jio|barodampay|aubank|idfcbank|pnb|unionbank(ofindia)?|indus|federal|rbl|yesbank|ikwik|wa(icici|hdfcbank|sbi|axis)';
const NEGATED = /\b(not|never|don'?t|do\s+not|nobody|no\s+one)\b[^.\n]{0,25}$/i;
const INDIA_PATTERNS = [
    { label: 'a UPI ID', re: new RegExp(`\\b[a-z0-9._-]{2,}@(${UPI_HANDLES})\\b(?!\\.)`, 'i') },
    { label: 'a request to pay to a UPI ID', re: /\b(pay|send|transfer)\b[^\n]{0,40}\bupi\s*(id|address|handle)\b/i },
    { label: 'an IFSC code', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
    { label: 'a NEFT/RTGS/IMPS transfer request', re: /\b(do|make|send|initiate|transfer|pay|remit)\b[^\n]{0,30}\b(neft|rtgs|imps)\b|\b(neft|rtgs|imps)\b[^\n]{0,30}\b(to|into)\s+(the\s+)?(following|this|new|below|above)\b/i },
    { label: 'a request for an OTP, UPI PIN, or CVV', test: (text) => {
        const re = /\b(share|send|tell|provide|enter|reply\s+with|forward)\b[^\n]{0,25}\b(otp|upi\s*pin|m-?pin|cvv)\b/gi;
        for (const m of text.matchAll(re)) {
            if (!NEGATED.test(text.slice(Math.max(0, m.index - 30), m.index + m[1].length))) return true;
        }
        return false;
    } },
    { label: 'a KYC/PAN/Aadhaar "verification" demand', re: /\b(kyc|pan|aadhaa?r)\b[^\n]{0,40}\b(updat|re-?verif|verif|expir|pending|suspen|block|deactivat|freez|frozen)|\b(updat|re-?verif|verif|complete|link)\w*\s+(your\s+)?(kyc|pan|aadhaa?r)\b[^\n]{0,60}\b(within|today|immediately|or\s+(else|your)|suspen|block|deactivat)/i },
    { label: 'a disconnection threat (electricity, gas, mobile)', re: /\b(electricity|power|gas|mobile|sim)\b[^\n]{0,40}\b(disconnect(ed|ion)?|cut\s+off|deactivat)/i },
    { label: 'a courier or customs fee', re: /\b(courier|parcel|package|customs)\b[^\n]{0,60}\b(fee|charges?|duty|pay)\b/i }
];

export function paymentWarnings(text) {
    const found = [...PAYMENT_PATTERNS, ...INDIA_PATTERNS]
        .filter(p => (p.test ? p.test(text) : p.re.test(text)))
        .map(p => p.label);
    if (URGENCY.test(text) && (PAYMENT_WORDS.test(text) || INR_AMOUNT.test(text))) found.push('urgent pressure to pay');
    if (!found.length) return [];
    return [`Payment red flags: ${found.join(', ')}. Verify any payment request through a contact you already trust (not details from this email) before acting.`];
}

// ---------------------------------------------------------------------------
// Sender checks
// ---------------------------------------------------------------------------

const lower = (s) => String(s || '').toLowerCase();

export function senderWarnings({ from = [], replyTo = [] }) {
    const warnings = [];
    const fromAddresses = from.map(a => lower(a.address)).filter(Boolean);
    const replyAddresses = replyTo.map(a => lower(a.address)).filter(Boolean);

    const mismatched = replyAddresses.filter(a => !fromAddresses.includes(a));
    if (mismatched.length) {
        warnings.push(`Reply-To (${mismatched.join(', ')}) differs from the sender (${fromAddresses.join(', ') || 'unknown'}). Replies would go to the Reply-To address.`);
    }

    for (const a of from) {
        const shownAddress = (String(a.name || '').match(/[^\s<>"']+@[^\s<>"']+\.[a-z]{2,}/i) || [])[0];
        if (shownAddress && lower(shownAddress) !== lower(a.address)) {
            warnings.push(`The sender's display name shows "${shownAddress}", but the email actually comes from "${a.address}". This is a common impersonation trick.`);
        }
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const BLOCKED_EXTENSIONS = new Set([
    'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'hta', 'lnk', 'reg', 'inf',
    'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'msc', 'jar', 'appref-ms', 'gadget',
    'sh', 'bash', 'zsh', 'command', 'tool', 'app', 'pkg', 'mpkg', 'dmg', 'workflow', 'scpt', 'applescript',
    'apk', 'deb', 'rpm', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'one', 'library-ms', 'url', 'website'
]);
const MACRO_EXTENSIONS = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'arj', 'lzh', 'ace']);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg', 'mht', 'mhtml', 'shtml']);
const EXECUTABLE_CONTENT_TYPES = /x-msdownload|x-msdos-program|x-executable|x-mach-binary|x-sh\b|x-msi|java-archive|x-apple-diskimage|vnd\.microsoft\.portable-executable/i;

function allowedByEnv(ext) {
    const allowed = (process.env.ATTACHMENT_ALLOW_EXTENSIONS || '').split(',').map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    return allowed.includes(ext);
}

/**
 * Identify executables by their first bytes, whatever the file is called
 */
export function executableSignature(content) {
    const b = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'Windows program (MZ header)';
    if (b.length >= 4 && b.readUInt32BE(0) === 0x7f454c46) return 'Linux program (ELF header)';
    if (b.length >= 4) {
        const magic = b.readUInt32BE(0);
        if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'macOS program (Mach-O header)';
    }
    if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return 'script (#! header)';
    return null;
}

export function checkAttachment({ filename = '', contentType = '', content, size }) {
    const name = String(filename).toLowerCase().trim().replace(/[.\s]+$/, '');
    const parts = name.split('.');
    const ext = parts.length > 1 ? parts.pop() : '';
    const warnings = [];

    const maxBytes = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024;
    const bytes = size ?? (content ? content.length : 0);
    if (bytes > maxBytes) {
        return { block: `"${filename}" is ${Math.round(bytes / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit (ATTACHMENT_MAX_BYTES).`, warnings };
    }

    const signature = executableSignature(content);
    if (signature && !allowedByEnv(ext)) {
        return { block: `"${filename}" is a ${signature}${ext ? ` disguised as .${ext}` : ''}. Executable files are not saved.`, warnings };
    }
    if (BLOCKED_EXTENSIONS.has(ext) && !allowedByEnv(ext)) {
        return { block: `"${filename}" has a blocked file type (.${ext}): programs and scripts are not saved.`, warnings };
    }
    if (EXECUTABLE_CONTENT_TYPES.test(contentType) && !allowedByEnv(ext)) {
        return { block: `"${filename}" is declared as a program (${contentType}). Executable files are not saved.`, warnings };
    }
    const innerExt = parts.length > 1 ? parts[parts.length - 1] : '';
    if (innerExt && (BLOCKED_EXTENSIONS.has(ext) || ['pdf', 'doc', 'docx', 'jpg', 'png', 'txt', 'xlsx'].includes(innerExt)) && ext !== innerExt && !['gz', 'bz2', 'xz'].includes(ext)) {
        warnings.push(`"${filename}" has a double extension (.${innerExt}.${ext}); the real type is .${ext}.`);
    }
    if (MACRO_EXTENSIONS.has(ext)) warnings.push(`"${filename}" is an Office file that can contain macros. Don't enable macros unless you trust the sender.`);
    if (isZip(ext, content)) {
        const zip = checkZipContents(filename, content);
        if (zip.block) return { block: zip.block, warnings };
        warnings.push(...zip.warnings);
    } else if (ARCHIVE_EXTENSIONS.has(ext)) {
        warnings.push(`"${filename}" is an archive (.${ext}) whose contents this server can't check; it may contain programs.`);
    }
    if (HTML_EXTENSIONS.has(ext)) warnings.push(`"${filename}" is a web page; attached web pages are often used for fake sign-in forms.`);
    return { block: null, warnings };
}

// ---------------------------------------------------------------------------
// ZIP inspection: read the list of files inside, without extracting anything
// ---------------------------------------------------------------------------

// ZIP-based document formats whose contents are not user files
const ZIP_DOCUMENT_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk', 'xpi', 'vsix', 'nupkg']);

/**
 * List the entries of a ZIP file from its central directory. Returns { entries: [{ name, encrypted }] }
 * or { error } when the archive can't be read (e.g. corrupted or ZIP64).
 */
export function inspectZip(content) {
    const b = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    // End of central directory record: at least 22 bytes, followed by a comment of up to 65535 bytes
    const searchStart = Math.max(0, b.length - 22 - 65535);
    let eocd = -1;
    for (let i = b.length - 22; i >= searchStart; i--) {
        if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return { error: 'no ZIP directory found' };

    const count = b.readUInt16LE(eocd + 10);
    const dirSize = b.readUInt32LE(eocd + 12);
    const dirOffset = b.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) return { error: 'ZIP64 archives are not inspected' };
    if (dirOffset + dirSize > b.length) return { error: 'ZIP directory is out of range' };

    const entries = [];
    let pos = dirOffset;
    for (let i = 0; i < count; i++) {
        if (pos + 46 > b.length || b.readUInt32LE(pos) !== 0x02014b50) return { error: 'ZIP directory is damaged' };
        const flags = b.readUInt16LE(pos + 8);
        const nameLength = b.readUInt16LE(pos + 28);
        const extraLength = b.readUInt16LE(pos + 30);
        const commentLength = b.readUInt16LE(pos + 32);
        const name = b.slice(pos + 46, pos + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
        entries.push({ name, encrypted: Boolean(flags & 0x1) });
        pos += 46 + nameLength + extraLength + commentLength;
    }
    return { entries };
}

function isZip(ext, content) {
    if (ZIP_DOCUMENT_EXTENSIONS.has(ext)) return false;
    const b = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    return ext === 'zip' || (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50);
}

function checkZipContents(filename, content) {
    const result = inspectZip(content);
    if (result.error) {
        return { block: null, warnings: [`"${filename}" is an archive whose contents couldn't be checked (${result.error}). Don't open programs inside it.`] };
    }
    const warnings = [];
    for (const entry of result.entries) {
        if (entry.name.endsWith('/')) continue;  // folder
        const base = entry.name.split('/').pop().toLowerCase().trim().replace(/[.\s]+$/, '');
        const ext = base.includes('.') ? base.split('.').pop() : '';
        if (BLOCKED_EXTENSIONS.has(ext) && !allowedByEnv(ext)) {
            return { block: `"${filename}" contains a program or script ("${entry.name}"). Archives with programs are not saved.`, warnings };
        }
        if (ARCHIVE_EXTENSIONS.has(ext)) warnings.push(`"${filename}" contains another archive ("${entry.name}"), a common way to hide programs from checks.`);
        if (MACRO_EXTENSIONS.has(ext)) warnings.push(`"${filename}" contains a macro-enabled Office file ("${entry.name}").`);
    }
    if (result.entries.some(e => e.encrypted)) {
        warnings.push(`"${filename}" is password-protected. Encrypted archives (with the password in the email) are a common way to get malware past scanners.`);
    }
    return { block: null, warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------------------
// Downloaded-file marking: the same "from the internet" tag browsers add
// ---------------------------------------------------------------------------

/**
 * Tag a saved file as downloaded, so the operating system checks it before it's opened:
 * macOS quarantine (Gatekeeper) or Windows Mark of the Web (SmartScreen, Office Protected View).
 * Returns { applied: true } or { applied: false, reason }. ATTACHMENT_QUARANTINE=false turns it off.
 */
export async function markDownloaded(filePath) {
    if (process.env.ATTACHMENT_QUARANTINE === 'false') return { applied: false, reason: 'turned off by ATTACHMENT_QUARANTINE=false' };
    if (process.platform === 'darwin') {
        const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};yahoo-mail-mcp;`;
        await new Promise((resolve, reject) => {
            execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, filePath], (err) => (err ? reject(err) : resolve()));
        });
        return { applied: true };
    }
    if (process.platform === 'win32') {
        await fs.writeFile(`${filePath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
        return { applied: true };
    }
    return { applied: false, reason: `no standard download marking on ${process.platform}` };
}

// ---------------------------------------------------------------------------
// Draft attachments: only from allowed folders
// ---------------------------------------------------------------------------

export function allowedAttachmentDirs() {
    const configured = (process.env.DRAFT_ATTACHMENT_DIRS || '').split(',').map(d => d.trim()).filter(Boolean);
    const dirs = configured.length ? configured : [path.join(os.homedir(), 'Downloads', 'yahoo-attachments')];
    return dirs.map(d => path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())));
}

/**
 * Resolve a draft attachment path, following symlinks, and refuse anything outside the allowed folders
 */
export async function resolveDraftAttachment(filePath) {
    const resolved = path.resolve(String(filePath).replace(/^~(?=$|\/)/, os.homedir()));
    let real;
    try {
        real = await fs.realpath(resolved);
    } catch (err) {
        throw new Error(`Cannot read attachment "${filePath}": ${err.message}`);
    }
    const dirs = allowedAttachmentDirs();
    const realDirs = await Promise.all(dirs.map(d => fs.realpath(d).catch(() => d)));
    if (!realDirs.some(dir => real === dir || real.startsWith(dir + path.sep))) {
        throw new Error(`Blocked: draft attachments can only come from ${dirs.join(', ')} (set DRAFT_ATTACHMENT_DIRS to change). "${filePath}" is outside.`);
    }
    return real;
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

const BUILT_IN = {
    readEmail: (ctx) => ({
        warnings: [
            ...senderWarnings({ from: ctx.from, replyTo: ctx.replyTo }),
            ...paymentWarnings(`${ctx.subject || ''}\n${ctx.body || ''}`)
        ]
    }),
    beforeSaveAttachment: (ctx) => checkAttachment(ctx),
    beforeDraft: (ctx) => ({
        warnings: [
            ...(ctx.replyToMismatch ? [ctx.replyToMismatch] : []),
            ...paymentWarnings(`${ctx.subject || ''}\n${ctx.body || ''}`).map(w => `This draft contains ${w.charAt(0).toLowerCase()}${w.slice(1)}`)
        ]
    })
};

const customHooksCache = new Map();  // module path -> loaded hooks
async function customHooks() {
    const modulePath = process.env.SAFETY_HOOKS_MODULE;
    if (!modulePath) return {};
    const resolved = path.resolve(modulePath.replace(/^~(?=$|\/)/, os.homedir()));
    if (!customHooksCache.has(resolved)) {
        customHooksCache.set(resolved, import(pathToFileURL(resolved).href).then(m => m.default || m));
    }
    return customHooksCache.get(resolved);
}

/**
 * Run the built-in hook and any custom hook for an event. Returns { warnings, block }.
 * A failing custom hook blocks the action (fail closed) rather than being ignored.
 */
export async function runHooks(event, ctx) {
    const results = [BUILT_IN[event] ? await BUILT_IN[event](ctx) : null];
    try {
        const custom = await customHooks();
        if (typeof custom[event] === 'function') results.push(await custom[event](ctx));
    } catch (err) {
        results.push({ block: `Custom safety hook "${event}" failed: ${err.message}` });
    }
    const warnings = results.flatMap(r => (r && Array.isArray(r.warnings) ? r.warnings : []));
    const block = results.map(r => r && r.block).find(Boolean) || null;
    return { warnings, block };
}

export function formatWarnings(warnings) {
    if (!warnings || !warnings.length) return '';
    return warnings.map(w => `⚠️ Server safety check: ${w}`).join('\n') + '\n';
}
