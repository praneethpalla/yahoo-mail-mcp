/**
 * Safety hooks: checks that run automatically at three points and either warn or block.
 *
 *   readEmail            - every email read: payment red flags, Reply-To mismatch, sender spoofing
 *   beforeSaveAttachment - before an attachment is written to disk: blocks executables and scripts
 *                          (by extension and by file contents), warns about macros, archives, HTML
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
const URGENCY = /\b(urgent(ly)?|immediately|asap|today|within\s+\d+\s+hours?|overdue|final\s+notice|past\s+due|act\s+now|avoid\s+(suspension|penalt))/i;
const PAYMENT_WORDS = /\b(pay|payment|invoice|transfer|wire|remit|refund|deposit)\b/i;

export function paymentWarnings(text) {
    const found = PAYMENT_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);
    if (URGENCY.test(text) && PAYMENT_WORDS.test(text)) found.push('urgent pressure to pay');
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

export function checkAttachment({ filename = '', contentType = '', content }) {
    const name = String(filename).toLowerCase().trim().replace(/[.\s]+$/, '');
    const parts = name.split('.');
    const ext = parts.length > 1 ? parts.pop() : '';
    const warnings = [];

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
    if (ARCHIVE_EXTENSIONS.has(ext)) warnings.push(`"${filename}" is an archive; it may contain programs. Check its contents before opening them.`);
    if (HTML_EXTENSIONS.has(ext)) warnings.push(`"${filename}" is a web page; attached web pages are often used for fake sign-in forms.`);
    return { block: null, warnings };
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
