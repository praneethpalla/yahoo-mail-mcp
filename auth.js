/**
 * Login helpers for the OAuth authorization page: password hashing (scrypt), TOTP codes
 * (RFC 6238, as used by authenticator apps), signed form tokens, and the login page HTML.
 * Uses only Node's crypto module.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Passwords: stored as "scrypt$N$r$p$<salt base64url>$<hash base64url>", never as plain text
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const { N, r, p } = SCRYPT_PARAMS;
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltText, hashText] = parts;
    const expected = Buffer.from(hashText, 'base64url');
    let actual;
    try {
        actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
            N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
        });
    } catch {
        return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238): 6 digits, 30-second steps, HMAC-SHA1, base32 secret
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(text) {
    const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const ch of clean) {
        const idx = BASE32.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

export function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secretBase32, counter, digits = 6) {
    const key = base32Decode(secretBase32);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
    return String(code).padStart(digits, '0');
}

/**
 * Check a 6-digit code, allowing one 30-second step of clock drift either way.
 * Returns the matched time step (so the caller can reject reuse), or null.
 */
export function verifyTotp(secretBase32, code, now = Date.now(), window = 1) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
    const step = Math.floor(now / 1000 / 30);
    for (let offset = -window; offset <= window; offset++) {
        const candidate = totpAt(secretBase32, step + offset);
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code.trim()))) {
            return step + offset;
        }
    }
    return null;
}

export function totpUri(secretBase32, account, issuer = 'Yahoo Mail MCP') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Signed form tokens: carry the authorization request through the login form without
// server-side sessions, so it can't be tampered with and expires after a few minutes
// ---------------------------------------------------------------------------

export function signFormToken(data, key, ttlSeconds = 600) {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(`form.${payload}`).digest('base64url');
    return `${payload}.${sig}`;
}

export function verifyFormToken(token, key) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', key).update(`form.${payload}`).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    let data;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function renderLoginPage({ formToken, redirectHost, mfaEnabled, error = '', username = '' }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in · Yahoo Mail MCP</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c1f24; --muted:#5b6370; --border:#d9dde3; --accent:#5b3fd6; --accent-text:#fff; --error-bg:#fdecec; --error:#a31515; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121417; --card:#1c1f24; --text:#eef0f3; --muted:#a3abb8; --border:#343a43; --accent:#8b74ff; --accent-text:#0d0b1a; --error-bg:#3a1618; --error:#ffb4b4; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding:16px; }
  main { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:14px; }
  p.sub strong { color:var(--text); font-weight:600; }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; font-size:16px; color:var(--text); background:var(--bg);
          border:1px solid var(--border); border-radius:8px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:22px; padding:11px; font-size:16px; font-weight:600; border:0; border-radius:8px;
           background:var(--accent); color:var(--accent-text); cursor:pointer; }
  .error { background:var(--error-bg); color:var(--error); padding:10px 12px; border-radius:8px; font-size:14px; margin-bottom:6px; }
  .note { margin-top:18px; font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Sign in to Yahoo Mail MCP</h1>
  <p class="sub">An app wants access to your mailbox. After signing in you'll return to <strong>${escapeHtml(redirectHost)}</strong>.</p>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/oauth/authorize" autocomplete="on">
    <input type="hidden" name="request" value="${escapeHtml(formToken)}">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}" ${username ? '' : 'autofocus'}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required ${username ? 'autofocus' : ''}>
    ${mfaEnabled ? `<label for="totp">Authenticator code</label>
    <input id="totp" name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" required>` : ''}
    <button type="submit">Sign in and allow access</button>
  </form>
  <p class="note">Only continue if you started connecting this server from an app you trust.</p>
</main>
</body>
</html>`;
}

export function renderErrorPage(message) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in error</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1c1f24;padding:16px}
@media (prefers-color-scheme:dark){body{background:#121417;color:#eef0f3}}main{max-width:420px}</style></head>
<body><main><h1 style="font-size:20px">Sign-in error</h1><p>${escapeHtml(message)}</p><p>Go back to your app and start connecting again.</p></main></body></html>`;
}
