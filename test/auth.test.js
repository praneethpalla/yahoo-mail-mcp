// Offline unit tests for auth.js: password hashing, TOTP, and signed form tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hashPassword, verifyPassword, base32Encode, base32Decode, totpAt, verifyTotp,
    generateTotpSecret, totpUri, signFormToken, verifyFormToken, renderLoginPage
} from '../auth.js';

test('password hashes verify only the right password and never contain it', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.ok(!hash.includes('correct horse'));
    assert.equal(verifyPassword('correct horse battery staple', hash), true);
    assert.equal(verifyPassword('correct horse battery stapl', hash), false);
    assert.notEqual(hashPassword('same'), hashPassword('same'), 'random salt');
    assert.equal(verifyPassword('x', 'plain-text-password'), false);
    assert.equal(verifyPassword(undefined, hash), false);
});

test('base32 round-trips', () => {
    const bytes = Buffer.from('12345678901234567890');
    assert.equal(base32Encode(bytes), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq'), bytes);
    assert.throws(() => base32Decode('not base32!'), /Invalid base32/);
});

test('TOTP matches the RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082');
    assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(totpAt(secret, Math.floor(1234567890 / 30)), '005924');
    assert.equal(totpAt(secret, Math.floor(2000000000 / 30)), '279037');
});

test('verifyTotp accepts one step of drift and returns the matched step', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const step = Math.floor(now / 1000 / 30);
    assert.equal(verifyTotp(secret, totpAt(secret, step), now), step);
    assert.equal(verifyTotp(secret, totpAt(secret, step - 1), now), step - 1);
    assert.equal(verifyTotp(secret, totpAt(secret, step + 1), now), step + 1);
    assert.equal(verifyTotp(secret, totpAt(secret, step + 3), now), null);
    assert.equal(verifyTotp(secret, 'abcdef', now), null);
    assert.equal(verifyTotp(secret, '', now), null);
});

test('otpauth URI has the secret and issuer', () => {
    const uri = totpUri('ABCDEFGHIJKLMNOP', 'me');
    assert.match(uri, /^otpauth:\/\/totp\/Yahoo%20Mail%20MCP%3Ame\?secret=ABCDEFGHIJKLMNOP&issuer=Yahoo%20Mail%20MCP/);
});

test('form tokens reject tampering, a different key, and expiry', () => {
    const key = Buffer.from('k'.repeat(32));
    const token = signFormToken({ redirect_uri: 'https://claude.ai/cb' }, key);
    assert.equal(verifyFormToken(token, key).redirect_uri, 'https://claude.ai/cb');

    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ redirect_uri: 'https://evil.example', exp: 9e9 })).toString('base64url');
    assert.equal(verifyFormToken(`${forged}.${sig}`, key), null);
    assert.equal(verifyFormToken(token, Buffer.from('x'.repeat(32))), null);
    assert.equal(verifyFormToken(signFormToken({}, key, -1), key), null);
    assert.equal(verifyFormToken('garbage', key), null);
    assert.ok(payload);
});

test('login page escapes values and shows the MFA field only when enabled', () => {
    const html = renderLoginPage({ formToken: 'a"b', redirectHost: '<claude.ai>', mfaEnabled: false, error: '<script>', username: '"x"' });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;claude.ai&gt;'));
    assert.ok(html.includes('value="a&quot;b"'));
    assert.ok(!html.includes('name="totp"'));
    assert.ok(renderLoginPage({ formToken: 't', redirectHost: 'h', mfaEnabled: true }).includes('name="totp"'));
});
