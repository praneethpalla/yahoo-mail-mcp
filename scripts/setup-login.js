#!/usr/bin/env node
/**
 * Set up the sign-in for remote (HTTP) mode: asks for a username and password, creates an
 * authenticator (MFA) secret, and writes the settings to a private file.
 *
 *   npm run setup-login -- --out ~/yahoo-mcp-login.txt
 *
 * Then copy AUTH_USERNAME, AUTH_PASSWORD_HASH, and AUTH_TOTP_SECRET into your server's
 * environment (Render dashboard or .env), and add the authenticator entry to your app.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { hashPassword, generateTotpSecret, totpUri } from '../auth.js';

// Line input shared across questions, so answers that arrive together (pasted or piped) aren't lost
let pending = '';
function readLine() {
    return new Promise((resolve) => {
        const take = () => {
            const newline = pending.indexOf('\n');
            if (newline === -1) return false;
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            resolve(line);
            return true;
        };
        if (take()) return;
        const onData = (chunk) => {
            pending += chunk.toString();
            if (take()) {
                process.stdin.off('data', onData);
                process.stdin.pause();
            }
        };
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
}

function ask(question, { hidden = false } = {}) {
    const { stdin, stdout } = process;
    stdout.write(question);
    if (!hidden || !stdin.isTTY) return readLine();

    // Hidden input: read raw keystrokes without echoing them
    return new Promise((resolve) => {
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        const onKey = (key) => {
            for (const ch of key.toString('utf8')) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.off('data', onKey);
                    stdin.pause();
                    stdout.write('\n');
                    resolve(value);
                    return;
                } else if (ch === '\u0003') {  // Ctrl+C
                    stdout.write('\n');
                    process.exit(130);
                } else if (ch === '\u007f' || ch === '\b') {
                    value = value.slice(0, -1);
                } else {
                    value += ch;
                }
            }
        };
        stdin.on('data', onKey);
    });
}

const outIndex = process.argv.indexOf('--out');
const outPath = outIndex !== -1 && process.argv[outIndex + 1]
    ? path.resolve(process.argv[outIndex + 1].replace(/^~(?=$|\/)/, os.homedir()))
    : null;

if (outPath && fs.existsSync(outPath)) {
    console.error(`Refusing to overwrite ${outPath}. Choose another --out path or delete the file first.`);
    process.exit(1);
}

const username = (await ask('Username: ')).trim();
if (!username) {
    console.error('Username cannot be empty.');
    process.exit(1);
}
const password = await ask('Password (at least 12 characters): ', { hidden: true });
if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
}
if ((await ask('Confirm password: ', { hidden: true })) !== password) {
    console.error('Passwords do not match.');
    process.exit(1);
}
const wantMfa = (await ask('Add an authenticator code (MFA)? [Y/n]: ')).trim().toLowerCase() !== 'n';

const lines = [
    '# Yahoo Mail MCP sign-in settings. Keep this file private and delete it once copied.',
    `AUTH_USERNAME=${username}`,
    `AUTH_PASSWORD_HASH=${hashPassword(password)}`
];
if (wantMfa) {
    const secret = generateTotpSecret();
    lines.push(
        `AUTH_TOTP_SECRET=${secret}`,
        '',
        '# Add this to your authenticator app (Google Authenticator, 1Password, Authy, ...):',
        '#   "Enter a setup key" -> account: Yahoo Mail MCP, key: the AUTH_TOTP_SECRET value above, time-based',
        `#   or open this link on the phone: ${totpUri(secret, username)}`
    );
}
const text = lines.join('\n') + '\n';

if (outPath) {
    fs.writeFileSync(outPath, text, { mode: 0o600 });
    console.log(`Saved to ${outPath} (readable only by you).`);
} else {
    console.log('\n' + text);
}
console.log('Next: copy the AUTH_* values into your server environment' + (wantMfa ? ' and add the key to your authenticator app.' : '.'));
