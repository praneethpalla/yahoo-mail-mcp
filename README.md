# Yahoo Mail MCP Server

A Model Context Protocol (MCP) server that provides full email management for Yahoo Mail via IMAP. It works with any MCP client (Claude, ChatGPT, Cursor, VS Code, and others): local stdio transport for desktop apps, and Streamable HTTP (plus legacy SSE) for remote access.

> **Forked from [jtokib/yahoo-mail-mcp-server](https://github.com/jtokib/yahoo-mail-mcp-server)** (MIT). The original provides the IMAP server, UID-based email tools, OAuth 2.0 flow, and Render/Docker deployment. This fork adds the features below.

## What's New in This Fork

- **Draft emails from any AI assistant**: `create_draft`, `create_reply_draft` (threaded, with reply-all and quoting), and `update_draft`, so the assistant can revise a draft from your feedback. Drafts land in Yahoo Mail's Drafts folder; **nothing is ever sent** without you.
- **Attachments**: `download_attachments` saves files to disk, and `read_email` lists attachment names, types, and sizes.
- **Streamable HTTP**: the current MCP transport at `/mcp`, stateless, so it survives cold starts and sleeping hosts. Legacy SSE still works.
- **One shared IMAP login**: tool calls reuse a single Yahoo login instead of logging in on every call, which avoids Yahoo's login throttling.
- **Faster bulk actions**: read/unread, flag, archive, and move run as one IMAP command; delete stays one email at a time.
- **Bug fixes**: empty `read_email` results for large emails, multi-email reads returning only the first email, sizes always 0, invalid search dates silently ignored, and a missing `isError` flag on errors.
- **App password only from a password store**: `YAHOO_APP_PASSWORD_COMMAND` reads it from macOS Keychain, 1Password, secret-tool, pass, or a mounted secret file. Plain-text passwords in `.env` are refused. With Keychain, every read needs your approval.
- **Sign-in page with MFA**: connecting an app opens a sign-in page (username, password, and a 6-digit authenticator code), like other connectors. Passwords are stored only as scrypt hashes, codes can't be reused, and 5 failed attempts lock an address out for 15 minutes. `npm run setup-login` creates the settings.
- **OAuth hardening**: signed access tokens that really expire after 1 hour, plus refresh tokens so clients stay connected without re-login, even across restarts and Render sleep. Authorization codes are random, single-use, and valid for 60 seconds. The `redirect_uri` check matches the exact hostname (the old substring check accepted URLs like `https://evil.example/?claude.ai`), and HTTP mode refuses to start without OAuth configured.
- **Offline test suite**: `npm test` runs 60 tests against fake IMAP servers and a local HTTP server, with no real email login.

## Project Status

| Area | Status |
|---|---|
| **Local mode** (stdio) with Claude Desktop | ✅ Tested against a real Yahoo mailbox: folders, search, multi-email reads, attachment download, new/reply/revised drafts, bulk flag/unflag, error handling |
| Other local clients (Cursor, VS Code, Codex CLI, ...) | ⚠️ Should work (standard MCP stdio), not yet tested |
| App password from macOS Keychain | ⚠️ The password-command mechanism is covered by offline tests; the Keychain setup itself hasn't been tried live yet |
| App password from Windows Credential Manager (`scripts/windows-credential.ps1`) | ⚠️ Not yet tested on Windows |
| **Hosted mode** (Streamable HTTP, OAuth, sign-in page with MFA) | ⚠️ **Experimental.** Covered by the offline test suite (60 tests, including the full sign-in and token flow and the official MCP SDK client), but **not yet tested end-to-end** on Render or with Claude.ai / ChatGPT connectors |
| ChatGPT connectors | ❓ Unverified. This server doesn't support dynamic client registration, so the client must let you enter a client ID and secret |

Feedback and issue reports from hosted setups are very welcome.

## Where Your Credentials Live (Read This First)

This server needs your Yahoo **app password**: a 16-character password Yahoo generates for one app (like a personal access token). It gives **full mailbox access** (read, move, delete, drafts) and also works for **sending mail over SMTP**. This server never sends, but anyone who steals the password could send as you and damage your sender reputation. It bypasses 2-step verification and **never expires** until you revoke it. Treat it like your real password. Where it lives depends on how you run the server:

| Setup | Who can see the app password | Who can see your email content | Use it from |
|---|---|---|---|
| **Local** (recommended): Claude Desktop, Cursor, VS Code, Codex CLI start the server on your computer | Only your computer, in a password store such as macOS Keychain (see below) | Only your computer | That computer's desktop apps |
| **Hosted** (optional): Render, Fly.io, a VPS, etc. | **The hosting provider** and anyone with access to your hosting account | Passes through the host's servers while tools run | Anywhere: Claude.ai web/mobile, ChatGPT, other remote MCP clients |

**Local setup:** the server runs as a local process, talks to the app through a pipe (stdio), and opens no network port. Your credentials never leave your machine. No sign-in page is needed because nothing is reachable from outside.

### Keep the app password in a password store, not a file

The server **only** reads the app password through `YAHOO_APP_PASSWORD_COMMAND`, a command that prints it. There is no plain-text option: if `YAHOO_APP_PASSWORD` is set, the server refuses to start. It runs the command once when it first needs to log in, keeps the result in memory only (never on disk or in logs), and runs it again after a failed login, for example after you rotate the password.

**macOS Keychain (recommended on a Mac):**

```bash
# 1. Store it. Type the app password at the prompt (hidden; it never appears in your shell history).
#    -T "" trusts no app, so macOS asks you to Allow or Deny every read.
security add-generic-password -a "you@yahoo.com" -s yahoo-mail-mcp -T "" -w

# 2. In .env, set:
YAHOO_APP_PASSWORD_COMMAND=security find-generic-password -a you@yahoo.com -s yahoo-mail-mcp -w
```

When your MCP app starts the server, macOS asks whether `security` may use the item:
- Click **Allow** (not "Always Allow") to keep approving each start. No program, including an AI assistant running commands on your machine, can then read the password without you seeing a dialog.
- "Always Allow" skips future dialogs, but then **any** program running as you can read it silently with the same command.

To update it after rotating: run the same `add-generic-password` command with `-U` added. To remove it: `security delete-generic-password -a "you@yahoo.com" -s yahoo-mail-mcp`.

**Windows Credential Manager:**

```powershell
# 1. Store it. You'll be prompted for the app password (hidden input).
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-credential.ps1 -Set -User you@yahoo.com

# 2. In .env (use the full path to your copy of the repository; quote it if it contains spaces):
YAHOO_APP_PASSWORD_COMMAND=powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\yahoo-mail-mcp\scripts\windows-credential.ps1"
```

The script uses Windows' own credential functions (no extra modules) and stores a Generic credential named `yahoo-mail-mcp`, visible under Control Panel > Credential Manager > Windows Credentials. Unlike Keychain's strict mode, **Credential Manager doesn't ask before each read**: any program running as your Windows user can read it. It is still encrypted by Windows and kept out of every project file. For per-read approval on Windows, use the 1Password CLI with Windows Hello (below).

**Other password stores:** `YAHOO_APP_PASSWORD_COMMAND` works with any command that prints the password, for example:
- 1Password CLI: `op read "op://Private/Yahoo MCP/password"`
- Linux (GNOME Keyring, KWallet): `secret-tool lookup service yahoo-mail-mcp`
- pass: `pass show yahoo-mail-mcp`

- Docker: a secret file mounted into the container, `cat /run/secrets/yahoo-app-password` (see Docker Usage)
- Render: a Render Secret File, `cat /etc/secrets/yahoo-app-password` (see Deploying to Render)

### Rotate after testing

Revoke the app password at [Yahoo account security](https://login.yahoo.com/account/security) when you finish testing or stop using a setup, then generate a new one for ongoing use. Yahoo lets you revoke app passwords one at a time without changing your main password.

**Hosted setup:** the server must hold the app password in readable form to log in to Yahoo, so **you are trusting the host**. The sign-in page, MFA, and OAuth protect who can *use* your server; they don't hide anything from the host itself. What the host holds:

| Setting | Stored on the host as | Notes |
|---|---|---|
| App password (Secret File, read via `YAHOO_APP_PASSWORD_COMMAND`) | Readable | Required to log in to Yahoo |
| `OAUTH_CLIENT_SECRET` | Readable | Signs access tokens; changing it logs out every app |
| `AUTH_TOTP_SECRET` | Readable | Required to check authenticator codes |
| Your sign-in password | **Hash only** (scrypt) | The real password is never stored anywhere |

**If you host it:**
1. **Create a separate app password just for the host** (e.g. named `MCP Render`), so you can revoke it without affecting anything else.
2. **Turn on 2-step verification for your hosting and GitHub accounts.** Someone breaking into those is a more likely risk than the host itself.
3. Store every credential as a **secret** environment variable, never in the repository.
4. **Revoke the app password** at [Yahoo account security](https://login.yahoo.com/account/security) after testing, whenever you stop hosting, or if you suspect a leak, and change `OAUTH_CLIENT_SECRET` to disconnect every app immediately.
5. Only host if you need web, mobile, or ChatGPT access. If you only use desktop apps, stay local.

**Logging:** the server logs request paths, OAuth events, and connection errors. It is written not to log passwords, tokens, secrets, email addresses, or email content.

**Never sent, never shared:** the server has no send-mail capability (drafts only), and each deployment serves one mailbox: yours. Nobody else's credentials are involved, and you never need to give yours to anyone else's server.

## Features

- **Secure OAuth 2.0 Authentication**: Protect your remote MCP server with OAuth 2.0 authorization code flow with PKCE
- **UID-Based Operations**: Uses permanent IMAP UIDs that don't change when emails are deleted (v3.0.0+)
- **Full Email Management**: Complete email operations with batch processing support
- **Fifteen Tools**:
  - `list_emails`: List recent emails with enriched metadata (size, flags, attachments) and pagination
  - `read_email`: Read the full content of emails (batch support)
  - `search_emails`: Advanced search with filters (date ranges, sender, unread status)
  - `list_folders`: Discover all available IMAP folders
  - `delete_emails`: Move emails to Trash (soft delete, recoverable)
  - `archive_emails`: Archive emails for long-term storage
  - `mark_as_read`: Mark emails as read
  - `mark_as_unread`: Mark emails as unread
  - `flag_emails`: Flag emails as important/starred
  - `unflag_emails`: Remove flag from emails
  - `move_emails`: Move emails to any folder
  - `download_attachments`: Save an email's attachments to disk
  - `create_draft`: Save a new email as a draft (never sent)
  - `create_reply_draft`: Save a threaded reply as a draft (never sent)
  - `update_draft`: Revise a draft, changing only the fields you pass
- **Drafts, Not Sending**: The server never sends email. Drafts appear in Yahoo Mail's Drafts folder for you to review and send, and the MCP client can revise them from your feedback
- **One Shared IMAP Login**: Tool calls reuse one Yahoo login (logged out after 5 minutes idle) instead of logging in every time, which avoids Yahoo's login throttling
- **Enriched Metadata**: All emails include UID, size, flags, hasAttachments, and folder information
- **Advanced Search**: Filter by date range, sender, unread status, and search across any folder
- **Batch Operations**: All management operations support processing multiple emails at once with accurate success/failure tracking
- **Transport Modes**:
  - `stdio`: For local desktop MCP clients (Claude Desktop, Cursor, VS Code, ...)
  - `http`: For remote access. Serves stateless Streamable HTTP at `/mcp` (current MCP standard) and legacy SSE at `/mcp/sse`
- **Cross-Platform**: Works on both Windows and Linux development environments
- **Docker Support**: Containerized deployment with Docker and Docker Compose
- **Cloud Ready**: Configured for easy deployment to Render.com with OAuth security

## Prerequisites

### For Local Development

- **Node.js**: Version 18.0.0 or higher
- **Yahoo Mail Account**: With app-specific password enabled
- **Git**: For version control

### For Docker Development/Deployment

- **Docker**: Latest version
- **Docker Compose**: Latest version (included with Docker Desktop on Windows/Mac)

### For Render.com Deployment

- **GitHub Account**: To host your repository
- **Render.com Account**: Free tier available at https://render.com

## Quick Start

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/praneethpalla/yahoo-mail-mcp.git
cd yahoo-mail-mcp

# Copy environment template
cp .env.example .env
```

### 2. Get Yahoo Mail App Password

1. Go to https://login.yahoo.com/account/security
2. Click "Generate app password" or "Manage app passwords"
3. Select "Other App" and enter "MCP Server"
4. Copy the generated 16-character password

### 3. Configure Environment

Edit `.env` file with your credentials:

First store the app password in your password store (see [Keep the app password in a password store](#keep-the-app-password-in-a-password-store-not-a-file)). On a Mac:

```bash
security add-generic-password -a your.email@yahoo.com -s yahoo-mail-mcp -T "" -w
```

Then edit `.env` (it never contains the password itself):

```env
YAHOO_EMAIL=your.email@yahoo.com
YAHOO_APP_PASSWORD_COMMAND=security find-generic-password -a your.email@yahoo.com -s yahoo-mail-mcp -w
TRANSPORT_MODE=stdio  # or 'http' for remote access
PORT=3000
```

### 4. Install Dependencies

**Windows (PowerShell):**
```powershell
npm install
```

**Linux/macOS (Bash):**
```bash
npm install
```

### 5. Run Locally

**stdio mode (for Claude Desktop):**
```bash
npm run start:stdio
```

**SSE mode (for testing HTTP endpoint):**
```bash
npm run start:sse
```

**Development mode (with auto-reload):**
```bash
npm run dev
```

## Docker Usage

### Build and Run with Docker

**Windows (PowerShell):**
```powershell
# Build the image
npm run docker:build

# Run the container
npm run docker:run

# Or use Docker Compose (recommended)
npm run docker:compose:up

# View logs
npm run docker:compose:logs

# Stop containers
npm run docker:compose:down
```

**Linux/macOS (Bash):**
```bash
# Build the image
npm run docker:build

# Run the container
npm run docker:run

# Or use Docker Compose (recommended)
npm run docker:compose:up

# View logs
npm run docker:compose:logs

# Stop containers
npm run docker:compose:down
```

### Manual Docker Commands

Put the app password in a secret file first (never in an environment variable):

```bash
mkdir -p secrets && printf '%s' 'your-app-password' > secrets/yahoo-app-password && chmod 600 secrets/yahoo-app-password
```

`secrets/` is gitignored and excluded from the image. If the container can't read the file (it runs as a non-root user), run it with your own user ID (`--user "$(id -u):$(id -g)"`). HTTP mode also needs the OAuth and `AUTH_*` settings in `.env` (see [Environment Variables Reference](#environment-variables-reference)).

**Windows (PowerShell):**
```powershell
# Build
docker build -t yahoo-mail-mcp .

# Run
docker run -p 3000:3000 --env-file .env `
  -v ${PWD}/secrets/yahoo-app-password:/run/secrets/yahoo-app-password:ro `
  -e YAHOO_APP_PASSWORD_COMMAND="cat /run/secrets/yahoo-app-password" `
  -e TRANSPORT_MODE=http `
  yahoo-mail-mcp

# Or with Docker Compose
docker-compose up -d
```

**Linux/macOS (Bash):**
```bash
# Build
docker build -t yahoo-mail-mcp .

# Run
docker run -p 3000:3000 --env-file .env \
  -v "$PWD/secrets/yahoo-app-password:/run/secrets/yahoo-app-password:ro" \
  -e YAHOO_APP_PASSWORD_COMMAND="cat /run/secrets/yahoo-app-password" \
  -e TRANSPORT_MODE=http \
  yahoo-mail-mcp

# Or with Docker Compose
docker-compose up -d
```

## Testing the Server

### Test Health Endpoint

**Windows (PowerShell):**
```powershell
# Using npm script
npm run test:health

# Using curl (if installed)
curl http://localhost:3000/health

# Using PowerShell
Invoke-WebRequest -Uri http://localhost:3000/health | Select-Object -Expand Content
```

**Linux/macOS (Bash):**
```bash
# Using npm script
npm run test:health

# Using curl
curl http://localhost:3000/health
```

### Test the Streamable HTTP Endpoint

With OAuth configured, first get a token, then call `/mcp`:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"YOUR_ID","client_secret":"YOUR_SECRET"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Run the Offline Test Suite

```bash
npm test
```

The tests use fake IMAP servers and a local HTTP server with dummy credentials, so they never log in to Yahoo.

### Test SSE Endpoint (legacy)

**Windows (PowerShell):**
```powershell
# Using npm script
npm run test:sse

# Using curl
curl http://localhost:3000/mcp/sse

# Using PowerShell
Invoke-WebRequest -Uri http://localhost:3000/mcp/sse
```

**Linux/macOS (Bash):**
```bash
# Using npm script
npm run test:sse

# Using curl
curl http://localhost:3000/mcp/sse
```

## Deploying to Render.com

> **Experimental:** hosted mode passes the offline tests but hasn't been tested end-to-end on Render yet. See [Project Status](#project-status).
>
> **Before you host:** the host will hold your Yahoo app password in readable form. Read [Where Your Credentials Live](#where-your-credentials-live-read-this-first), and use a separate, revocable app password for the host.

### Step 1: Prepare Your Repository

**Windows (PowerShell):**
```powershell
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit: Yahoo Mail MCP Server"

# Create GitHub repository at https://github.com/new
# Then push to GitHub
git remote add origin https://github.com/yourusername/yahoo-mail-mcp-server.git
git branch -M main
git push -u origin main
```

**Linux/macOS (Bash):**
```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit: Yahoo Mail MCP Server"

# Create GitHub repository at https://github.com/new
# Then push to GitHub
git remote add origin https://github.com/yourusername/yahoo-mail-mcp-server.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy to Render

1. **Sign up/Login to Render.com**
   - Go to https://render.com
   - Click "Get Started for Free" or "Login"

2. **Connect GitHub Repository**
   - Click "New +" button in top right
   - Select "Web Service"
   - Click "Connect GitHub" and authorize Render
   - Select your `yahoo-mail-mcp-server` repository

3. **Configure the Service**
   - **Name**: `yahoo-mail-mcp-server` (or your preferred name)
   - **Runtime**: Docker
   - **Region**: Choose closest to you (Oregon, Frankfurt, Singapore, Ohio)
   - **Branch**: `main`
   - **Plan**: Free (or Starter for production)

4. **Set Environment Variables**

   In the "Environment" section, click "Add Environment Variable" and add:

   | Key | Value | How to Generate |
   |-----|-------|-----------------|
   | `NODE_ENV` | `production` | - |
   | `TRANSPORT_MODE` | `http` | - |
   | `TRUST_PROXY` | `1` | - (Render runs behind one proxy; needed for per-address sign-in lockouts) |
   | `YAHOO_EMAIL` | `your.email@yahoo.com` | Your Yahoo email address |
   | `YAHOO_APP_PASSWORD_COMMAND` | `cat /etc/secrets/yahoo-app-password` | Already set by `render.yaml` |
   | `OAUTH_CLIENT_ID` | `32-char-hex-string` | Run: `openssl rand -hex 16` |
   | `OAUTH_CLIENT_SECRET` | `64-char-hex-string` | Run: `openssl rand -hex 32` |
   | `AUTH_USERNAME` | your sign-in name | Run: `npm run setup-login -- --out ~/yahoo-mcp-login.txt` |
   | `AUTH_PASSWORD_HASH` | `scrypt$...` | From the same file (a hash, never the password itself) |
   | `AUTH_TOTP_SECRET` | base32 secret | From the same file; also add it to your authenticator app |

   `npm run setup-login` asks for a username and password (hidden while typing), creates an authenticator secret, and writes all three `AUTH_*` values to the file you choose (readable only by you). Add the secret to Google Authenticator, 1Password, Authy, or similar via "Enter a setup key", then delete the file once everything is copied.

   **Important**:
   - **App password:** under Environment > **Secret Files**, add a file named `yahoo-app-password` containing only the app password. Render mounts it at `/etc/secrets/yahoo-app-password`; it is never an environment variable
   - Mark `YAHOO_EMAIL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `AUTH_PASSWORD_HASH`, and `AUTH_TOTP_SECRET` as "Secret"
   - The server refuses to start in HTTP mode without the OAuth and `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` settings
   - `PORT` is automatically set by Render, don't add it manually
   - Save the OAuth credentials - you'll need them to configure Claude Desktop

5. **Deploy**
   - Click "Create Web Service"
   - Render will automatically build and deploy your Docker container
   - Wait for deployment to complete (first build takes 5-10 minutes)

6. **Get Your Service URL**
   - Once deployed, you'll get a URL like: `https://yahoo-mail-mcp-server.onrender.com`
   - Test it by visiting: `https://yahoo-mail-mcp-server.onrender.com/health`

### Step 3: Connect to Claude Desktop

**Note**: Remote MCP servers require a Claude Pro, Max, Team, or Enterprise plan.

1. **Open Claude Desktop**
   - Launch the Claude Desktop app on your computer

2. **Add MCP Connector**
   - Click on your profile icon or menu
   - Select "Settings"
   - Navigate to "Connectors" section
   - Click "Add Custom Connector"

3. **Configure the Connector**
   - **Name**: `Yahoo Mail`
   - **URL**: `https://your-service-name.onrender.com/mcp`

   Example:
   ```
   https://yahoo-mail-mcp-server.onrender.com/mcp
   ```

   Use `/mcp` (Streamable HTTP) for current clients. Older clients that only support SSE can use `/mcp/sse`.

4. **Configure OAuth Authentication**
   - Click **"Advanced Settings"** ⚙️
   - Enter the OAuth credentials from Step 4:
     - **OAuth Client ID**: The value from `OAUTH_CLIENT_ID` environment variable
     - **OAuth Client Secret**: The value from `OAUTH_CLIENT_SECRET` environment variable

5. **Save and Test**
   - Click "Add" or "Save", then "Connect"
   - A sign-in page opens: enter your username, password, and the 6-digit code from your authenticator app
   - Claude receives a token and refreshes it automatically; you only sign in again if the connection goes unused for 30 days
   - If successful, you'll see the connector active
   - You can now use Yahoo Mail tools in your conversations!

**Other MCP clients (e.g. ChatGPT):** add the same `/mcp` URL and OAuth credentials in the client's connector settings, and add the client's OAuth redirect host to `OAUTH_REDIRECT_HOSTS` (e.g. `claude.ai,claude.com,chatgpt.com`). By default only Claude's redirect hosts and localhost are allowed. This server does not support dynamic client registration, so the client must let you enter a client ID and secret.

### Step 4: Using the MCP Server

Once connected, you can use these tools in your conversations:

```
Can you list my recent emails?

Can you read email number 5?

Can you search for emails from john@example.com?

Download the attachments from the latest email from my bank.

Draft a reply to Alice saying I'll review the budget by Friday. Then make it more formal.
```

## Troubleshooting

### Common Issues

#### 1. "Authentication failed" error

**Solution**: Verify your app-specific password
- Make sure you're using an app-specific password, not your regular Yahoo password
- Generate a new app-specific password at https://login.yahoo.com/account/security
- Check for typos in your `.env` file or Render environment variables

#### 2. Docker build fails on Windows

**Solution**: Check Docker Desktop settings
- Ensure Docker Desktop is running
- Check that WSL2 is enabled (Settings > General > Use WSL2 based engine)
- Verify file sharing is enabled (Settings > Resources > File Sharing)

#### 3. Port 3000 already in use

**Solution**: Change the port

**Windows (PowerShell):**
```powershell
$env:PORT=3001; npm run start:sse
```

**Linux/macOS (Bash):**
```bash
PORT=3001 npm run start:sse
```

Or edit `.env`:
```env
PORT=3001
```

#### 4. Render deployment fails

**Solution**: Check the logs
- Go to your Render dashboard
- Click on your service
- Click "Logs" tab
- Look for error messages
- Common issues:
  - Missing environment variables
  - Incorrect Dockerfile path
  - Build timeout (increase build timeout in settings)

#### 5. SSE connection drops

**Solution**: Render free tier limitations
- Free tier services sleep after 15 minutes of inactivity
- First request after sleep takes 30-60 seconds to wake up
- Upgrade to Starter plan ($7/month) for always-on service

#### 6. IMAP connection timeout

**Solution**: Check Yahoo Mail IMAP settings
- Ensure IMAP is enabled in Yahoo Mail settings
- Go to Yahoo Mail > Settings > More Settings > Mailboxes
- Verify IMAP access is allowed
- Check firewall settings aren't blocking port 993

### Windows-Specific Issues

#### Line Ending Problems

If you see errors about line endings:

**PowerShell:**
```powershell
# Configure git to handle line endings correctly
git config --global core.autocrlf input

# Re-clone the repository
git clone <your-repo-url>
```

#### npm Scripts Not Working

If cross-platform scripts fail:

**PowerShell:**
```powershell
# Install cross-env globally
npm install -g cross-env

# Or run scripts directly
node server.js
```

### Linux-Specific Issues

#### Permission Errors with Docker

**Bash:**
```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Logout and login again, or run:
newgrp docker

# Test
docker ps
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `YAHOO_EMAIL` | Yes | - | Your Yahoo Mail email address |
| `YAHOO_APP_PASSWORD_COMMAND` | Yes | - | Command that prints the app password, e.g. `security find-generic-password -a you@yahoo.com -s yahoo-mail-mcp -w` (macOS Keychain), `cat /run/secrets/yahoo-app-password` (Docker), or `cat /etc/secrets/yahoo-app-password` (Render). Run once per login; the result stays in memory only |
| `YAHOO_APP_PASSWORD` | **Not supported** | - | Plain-text app passwords are refused: the server won't start if this is set |
| `OAUTH_CLIENT_ID` | Yes (Remote) | - | OAuth 2.0 client ID for MCP server authentication (generate with `openssl rand -hex 16`) |
| `OAUTH_CLIENT_SECRET` | Yes (Remote) | - | OAuth 2.0 client secret for MCP server authentication (generate with `openssl rand -hex 32`) |
| `TRANSPORT_MODE` | No | `stdio` | `stdio`, or `http` for remote access (Streamable HTTP at `/mcp` + legacy SSE at `/mcp/sse`; `sse` is an alias) |
| `PORT` | No | `3000` | Port for HTTP mode (auto-set by Render) |
| `OAUTH_ACCESS_TOKEN_TTL` | No | `3600` | Access token lifetime in seconds |
| `OAUTH_REFRESH_TOKEN_TTL` | No | `2592000` | Refresh token lifetime in seconds (30 days). Each refresh token can be used once and is replaced |
| `AUTH_USERNAME` | Yes (Remote) | - | Username for the sign-in page |
| `AUTH_PASSWORD_HASH` | Yes (Remote) | - | scrypt hash of the sign-in password, from `npm run setup-login` (plain passwords are rejected) |
| `AUTH_TOTP_SECRET` | Recommended (Remote) | - | Base32 authenticator secret from `npm run setup-login`; when set, sign-in also asks for a 6-digit code |
| `TRUST_PROXY` | No | - | Express "trust proxy" setting. Set to `1` on Render so sign-in lockouts apply per client address. Don't set it when the server is reached directly, or clients could fake their address |
| `ALLOW_CLIENT_CREDENTIALS` | No | - | Set to `true` to allow the `client_credentials` grant, which skips the sign-in page. Only for trusted machine-to-machine use |
| `ALLOW_UNAUTHENTICATED` | No | - | Set to `true` to run HTTP mode without OAuth or a sign-in. **Local testing only**: anyone who can reach the server can read and change the mailbox |
| `OAUTH_REDIRECT_HOSTS` | No | `claude.ai,claude.com` | Hostnames allowed as OAuth redirect targets (https only; subdomains allowed; localhost is always allowed). Add other clients, e.g. `chatgpt.com` |
| `DRAFTS_FOLDER` | No | auto-detected | Drafts folder name. Normally detected from the server's `\Drafts` folder flag (Yahoo: `Draft`) |
| `IMAP_IDLE_MS` | No | `300000` | Log out of the shared IMAP connection after this many milliseconds without use |
| `ENV_FILE` | No | `.env` | Env file to load, relative to `server.js` (e.g. `.env.test` for a test account) |
| `NODE_ENV` | No | `development` | Environment: `development` or `production` |

**Note**: The OAuth and `AUTH_*` settings are only required for remote deployments (Render.com); HTTP mode refuses to start without them. Local stdio mode doesn't use OAuth or a sign-in.

## Available npm Scripts

| Script | Description | Cross-Platform |
|--------|-------------|----------------|
| `npm start` | Start server (stdio mode) | ✅ |
| `npm run start:stdio` | Start in stdio mode | ✅ |
| `npm run start:sse` | Start in SSE mode | ✅ |
| `npm run dev` | Development mode with auto-reload | ✅ |
| `npm run docker:build` | Build Docker image | ✅ |
| `npm run docker:run` | Run Docker container | ✅ |
| `npm run docker:compose:up` | Start with Docker Compose | ✅ |
| `npm run docker:compose:down` | Stop Docker Compose | ✅ |
| `npm run docker:compose:logs` | View Docker Compose logs | ✅ |
| `npm run test:health` | Test health endpoint | ✅ |
| `npm run test:sse` | Test SSE endpoint | ✅ |
| `npm test` | Run the offline test suite (no Yahoo logins) | ✅ |
| `npm run setup-login` | Create sign-in settings (username, password hash, authenticator secret) | ✅ |

## Project Structure

```
yahoo-mail-mcp-server/
├── server.js                 # Main server code
├── package.json             # Node.js dependencies and scripts
├── Dockerfile               # Docker build configuration
├── docker-compose.yml       # Docker Compose configuration
├── render.yaml              # Render.com deployment config
├── .env.example             # Environment variable template
├── .env                     # Your local environment variables (gitignored)
├── .dockerignore            # Files to exclude from Docker build
├── .gitignore               # Files to exclude from git
├── .gitattributes           # Git line ending configuration
├── auth.js                  # Sign-in helpers: password hashing, TOTP, login page
├── scripts/setup-login.js   # Creates the AUTH_* sign-in settings
├── scripts/windows-credential.ps1  # Stores/reads the app password in Windows Credential Manager
├── test/                    # Offline tests (node --test), fake IMAP servers
└── README.md                # This file
```

## Security Best Practices

1. **OAuth 2.0 Protection** (Remote Deployments)
   - Server requires OAuth 2.0 authentication for all MCP requests
   - Uses authorization code flow with PKCE (Proof Key for Code Exchange, S256)
   - Connecting an app requires signing in on the server's own page: username, password, and (recommended) a 6-digit authenticator code (TOTP, RFC 6238)
   - The password is stored only as a scrypt hash; authenticator codes are single-use; 5 failed sign-ins from one address lock it out for 15 minutes
   - The sign-in page can't be framed (clickjacking), isn't cached, loads nothing external, and its hidden fields are signed so they can't be altered
   - The `client_credentials` grant (no sign-in) is off unless `ALLOW_CLIENT_CREDENTIALS=true`
   - Only clients with correct credentials can access your emails
   - Access tokens are signed (HMAC-SHA256, key derived from `OAUTH_CLIENT_SECRET`) and expire after 1 hour; clients renew them with single-use refresh tokens (30 days) without asking the user to log in again
   - Tokens need no server-side storage, so they keep working across restarts and Render sleep
   - **Emergency logout**: changing `OAUTH_CLIENT_SECRET` immediately invalidates every issued token
   - Authorization codes are random, valid for 60 seconds, single-use, and bound to their `redirect_uri`
   - HTTP mode refuses to start without OAuth credentials (override with `ALLOW_UNAUTHENTICATED=true` for local testing only)
   - Generate strong random credentials: `openssl rand -hex 16` and `openssl rand -hex 32`
   - Store credentials securely in Render dashboard (marked as "Secret")

2. **Never commit credentials**
   - `.env` file is gitignored
   - Always use `.env.example` as template
   - Set sensitive values in Render dashboard
   - Never share OAuth credentials publicly

3. **Use app-specific passwords**
   - Never use your main Yahoo password
   - Generate new passwords for each service
   - Revoke unused passwords regularly
   - App passwords can be revoked without changing your main password

4. **Email management operations**
   - Modification operations are reversible (soft delete, not permanent), except that `update_draft` permanently removes the previous version of the draft it revises
   - Deleted emails are moved to Trash folder (recoverable within 7 days for free accounts)
   - Archive, flag, and read status changes are non-destructive
   - Move operations preserve email content and metadata
   - No send operations - server cannot send emails on your behalf

5. **HTTPS in production**
   - Render.com provides free SSL certificates
   - All traffic is encrypted (TLS/SSL)
   - IMAP connection uses TLS
   - OAuth tokens transmitted securely

## Development Workflow

### Making Changes

**Windows (PowerShell):**
```powershell
# 1. Make your changes to server.js

# 2. Test locally
npm run dev

# 3. Test with Docker
npm run docker:compose:up

# 4. Commit and push
git add .
git commit -m "Description of changes"
git push origin main

# 5. Render automatically deploys the changes
```

**Linux/macOS (Bash):**
```bash
# 1. Make your changes to server.js

# 2. Test locally
npm run dev

# 3. Test with Docker
npm run docker:compose:up

# 4. Commit and push
git add .
git commit -m "Description of changes"
git push origin main

# 5. Render automatically deploys the changes
```

### Viewing Logs

**Local Development:**
```bash
# The server logs to stderr
npm run start:sse
```

**Docker:**
```bash
npm run docker:compose:logs
```

**Render.com:**
- Go to your service dashboard
- Click "Logs" tab
- Real-time logs appear here

## API Endpoints

When running in HTTP mode (`TRANSPORT_MODE=http`), the server exposes these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API information and available tools |
| `/health` | GET | Health check (returns status, version, timestamp) |
| `/mcp` | POST | Streamable HTTP endpoint for MCP, stateless with JSON replies (requires OAuth token). GET/DELETE return 405 |
| `/mcp/sse` | GET | Legacy Server-Sent Events endpoint for MCP (requires OAuth token) |
| `/mcp/message` | POST | Legacy SSE message endpoint (requires OAuth token) |
| `/.well-known/oauth-protected-resource/mcp` | GET | OAuth protected resource metadata for `/mcp` (also advertised in `WWW-Authenticate` on 401 responses) |
| `/.well-known/oauth-authorization-server` | GET | OAuth 2.0 server metadata (RFC 8414) |
| `/.well-known/openid-configuration` | GET | OpenID Connect discovery endpoint |
| `/oauth/authorize` | GET | OAuth 2.0 authorization endpoint |
| `/oauth/token` | POST | OAuth 2.0 token endpoint |

### Example Health Check Response

```json
{
  "status": "ok",
  "service": "yahoo-mail-mcp",
  "version": "3.1.0",
  "timestamp": "2026-09-26T12:34:56.789Z"
}
```

## Breaking Changes & Migration Guide

### ⚠️ v3.0.0 Breaking Changes

Version 3.0.0 introduces **UID-based operations** which fundamentally changes how you interact with emails. This is a breaking change that requires updating your code.

#### What Changed

**1. Parameter Rename: `sequenceNumbers` → `uids`**

All email management tools now use `uids` (permanent identifiers) instead of `sequenceNumbers` (temporary positions):

```javascript
// ❌ v2.x (OLD - sequence numbers)
read_email({ sequenceNumbers: [1, 2, 3] })
delete_emails({ sequenceNumbers: [5] })

// ✅ v3.0.0 (NEW - UIDs)
read_email({ uids: [510867, 510866, 510862] })
delete_emails({ uids: [510867] })
```

**2. Response Format: Plain Text → JSON**

All tools now return structured JSON instead of plain text:

```javascript
// ❌ v2.x response
"Email 1 of 10..."

// ✅ v3.0.0 response
{
  "emails": [...],
  "totalCount": 10,
  "returned": 10
}
```

**3. New Required Workflow**

You must now get UIDs from `list_emails` or `search_emails` before performing operations:

```javascript
// Step 1: Get UIDs
const result = list_emails({ count: 10 });
// Returns: { emails: [{ uid: 510867, ... }, { uid: 510866, ... }] }

// Step 2: Use UIDs for operations
const uidsToDelete = [510867, 510866];
delete_emails({ uids: uidsToDelete });
```

#### Why UIDs Are Better

**Sequence Numbers (v2.x):**
- ❌ Change when emails are deleted
- ❌ Position-based (email #1, #2, #3)
- ❌ Can become invalid between operations
- ❌ Cause confusion and errors

**UIDs (v3.0.0):**
- ✅ Permanent identifiers assigned by IMAP server
- ✅ Never change, even when other emails are deleted
- ✅ Always valid until email is permanently deleted
- ✅ Reliable for batch operations

#### Migration Checklist

- [ ] Update all tool calls to use `uids` parameter instead of `sequenceNumbers`
- [ ] Update code to get UIDs from `list_emails` or `search_emails` first
- [ ] Update code to handle JSON responses instead of plain text
- [ ] Test batch operations to ensure all UIDs are processed (v3.0.0 fixes critical batch bug)
- [ ] Review new features: pagination, enriched metadata, advanced search, folder support

#### New Features in v3.0.0

1. **Enriched Metadata**: All emails include `uid`, `size`, `flags`, `hasAttachments`
2. **Pagination**: `list_emails` supports `offset` and `limit` parameters
3. **Advanced Search**: `search_emails` supports date ranges, sender filter, unread-only
4. **Folder Support**: All tools support `folder` parameter (default: INBOX)
5. **list_folders**: New tool to discover available IMAP folders
6. **Accurate Batch Operations**: Fixed critical bug where only first UID was processed
7. **Enhanced Error Handling**: Better timeout and connection error messages

## MCP Tools

### list_emails

List recent emails with enriched metadata (UID, size, flags, attachments) and pagination support.

**Parameters:**
- `count` (optional): Number of emails to retrieve (default: 10, max: 50)
- `folder` (optional): Folder to list from (default: 'INBOX'). Use `list_folders` to see available folders
- `offset` (optional): Number of emails to skip for pagination (default: 0)

**Response:** JSON with `emails` array containing enriched metadata for each email:
- `uid`: Permanent IMAP UID (use this for all operations)
- `sequenceNumber`: Position in folder (for reference only, don't use for operations)
- `from`: Sender address
- `subject`: Email subject
- `date`: Date in RFC 2822 format
- `size`: Email size in bytes
- `flags`: Array of IMAP flags (e.g., `['\\Seen']`, `['\\Flagged']`)
- `hasAttachments`: Boolean indicating if email has attachments

**Examples:**
```javascript
// List 20 most recent emails
list_emails({ count: 20 })

// List emails with pagination (skip first 10)
list_emails({ count: 10, offset: 10 })

// List emails from Sent folder
list_emails({ count: 15, folder: "Sent" })
```

### read_email

Read the full content of emails using UIDs (supports batch reading).

**Parameters:**
- `uids` (required): Array of UIDs to read (get UIDs from `list_emails` or `search_emails`)
- `folder` (optional): Folder containing the emails (default: 'INBOX')

**Response:** Email headers, size, flags, attachment list (name, type, size), and body content, returned in the order the UIDs were requested

**Examples:**
```javascript
// Read a single email
read_email({ uids: [510867] })

// Read multiple emails
read_email({ uids: [510867, 510866, 510862] })

// Read email from Sent folder
read_email({ uids: [510867], folder: "Sent" })
```

### search_emails

Advanced search with filters for date ranges, sender, and unread status.

**Parameters:**
- `query` (optional): Search term for subject or sender (can be empty for date-only searches)
- `count` (optional): Number of results to return (default: 10, max: 50)
- `dateFrom` (optional): Filter emails from this date onwards (ISO 8601 or RFC 2822 format)
- `dateTo` (optional): Filter emails up to this date (ISO 8601 or RFC 2822 format)
- `sender` (optional): Filter by specific sender email address or name
- `unreadOnly` (optional): Only return unread emails (default: false)
- `folder` (optional): Folder to search in (default: 'INBOX')

**Response:** JSON with `emails` array, `totalMatches`, `returned`, `query`, `filters`, and `folder`

**Examples:**
```javascript
// Basic search
search_emails({ query: "invoice", count: 15 })

// Search unread emails only
search_emails({ query: "meeting", unreadOnly: true })

// Search by date range
search_emails({ dateFrom: "2025-01-01", dateTo: "2025-01-31" })

// Search by sender
search_emails({ sender: "boss@company.com" })

// Combined filters
search_emails({
  query: "report",
  sender: "team@company.com",
  dateFrom: "2025-01-15",
  unreadOnly: true
})
```

### list_folders

Discover all available IMAP folders in your Yahoo Mail account.

**Parameters:** None

**Response:** JSON with array of folder objects containing `name`, `path`, `delimiter`, and `children`

**Example:**
```javascript
// List all folders
list_folders()

// Example response:
// {
//   "folders": [
//     { "name": "INBOX", "path": "INBOX" },
//     { "name": "Sent", "path": "Sent" },
//     { "name": "Trash", "path": "Trash" },
//     { "name": "Archive", "path": "Archive" }
//   ]
// }
```

### delete_emails

Move emails to Trash folder using UIDs (soft delete - emails can be recovered).

**Parameters:**
- `uids` (required): Array of UIDs to delete (get UIDs from `list_emails` or `search_emails`)
- `folder` (optional): Source folder (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Delete a single email
delete_emails({ uids: [510867] })

// Delete multiple emails
delete_emails({ uids: [510867, 510866, 510862, 510856] })

// Delete from Sent folder
delete_emails({ uids: [510867], folder: "Sent" })
```

### archive_emails

Move emails to Archive folder using UIDs for long-term storage.

**Parameters:**
- `uids` (required): Array of UIDs to archive
- `folder` (optional): Source folder (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Archive a single email
archive_emails({ uids: [510867] })

// Archive multiple emails
archive_emails({ uids: [510867, 510866, 510862, 510851] })
```

### mark_as_read

Mark emails as read using UIDs by adding the Seen flag.

**Parameters:**
- `uids` (required): Array of UIDs to mark as read
- `folder` (optional): Folder containing the emails (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Mark a single email as read
mark_as_read({ uids: [510867] })

// Mark multiple emails as read
mark_as_read({ uids: [510867, 510866, 510862, 510851, 510865] })
```

### mark_as_unread

Mark emails as unread using UIDs by removing the Seen flag.

**Parameters:**
- `uids` (required): Array of UIDs to mark as unread
- `folder` (optional): Folder containing the emails (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Mark a single email as unread
mark_as_unread({ uids: [510867] })

// Mark multiple emails as unread
mark_as_unread({ uids: [510869, 510867, 510866] })
```

### flag_emails

Flag emails as important/starred using UIDs by adding the Flagged flag.

**Parameters:**
- `uids` (required): Array of UIDs to flag
- `folder` (optional): Folder containing the emails (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Flag a single email
flag_emails({ uids: [510867] })

// Flag multiple emails
flag_emails({ uids: [510851, 510865, 510864] })
```

### unflag_emails

Remove flag/star from emails using UIDs by removing the Flagged flag.

**Parameters:**
- `uids` (required): Array of UIDs to unflag
- `folder` (optional): Folder containing the emails (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Unflag a single email
unflag_emails({ uids: [510867] })

// Unflag multiple emails
unflag_emails({ uids: [510867, 510866, 510862] })
```

### move_emails

Move emails to a specified folder using UIDs.

**Parameters:**
- `uids` (required): Array of UIDs to move
- `folderName` (required): Name of the destination folder (e.g., "Work", "Personal", "Archive")
- `sourceFolder` (optional): Source folder (default: 'INBOX')

**Response:** Success/failure message with accurate count of processed emails

**Examples:**
```javascript
// Move a single email to Work folder
move_emails({ uids: [510867], folderName: "Work" })

// Move multiple emails to Personal folder
move_emails({ uids: [510867, 510866, 510862], folderName: "Personal" })

// Move from Sent to Archive
move_emails({ uids: [510867], folderName: "Archive", sourceFolder: "Sent" })
```

**Note:** `mark_as_read`, `mark_as_unread`, `flag_emails`, `unflag_emails`, `archive_emails`, and `move_emails` first check which UIDs exist, then process them in one IMAP command (falling back to one at a time if that fails). `delete_emails` always processes one email at a time.

### download_attachments

Save an email's attachments to disk. The email is opened read-only, so it isn't marked as read.

**Parameters:**
- `uid` (required): UID of the email
- `folder` (optional): Folder containing the email (default: 'INBOX')
- `filenames` (optional): Only download attachments with these filenames (default: all)
- `saveDir` (optional): Directory to save to (default: `~/Downloads/yahoo-attachments`)

**Response:** Paths, types, and sizes of the saved files. Existing files are never overwritten; copies get names like `report (1).pdf`.

**Examples:**
```javascript
download_attachments({ uid: 581266 })
download_attachments({ uid: 581266, filenames: ["invoice.pdf"], saveDir: "~/Documents/invoices" })
```

**Note:** In remote (HTTP) mode, files are saved on the server's disk, not your computer.

### create_draft

Save a new email to the Drafts folder. **Nothing is sent**; review and send it from Yahoo Mail.

**Parameters:**
- `to` (required): Array of recipient addresses, e.g. `["Jane <jane@example.com>"]`
- `cc`, `bcc` (optional): Arrays of addresses (Bcc is kept on the draft)
- `subject` (required), `body` (required): Subject and plain-text body
- `html` (optional): HTML version of the body (default: plain text only)
- `attachments` (optional): Paths of local files to attach

**Response:** The full draft (recipients, subject, body, attachment names) and its UID

**Example:**
```javascript
create_draft({ to: ["jane@example.com"], subject: "Lunch Friday?", body: "Hi Jane, are you free for lunch on Friday?" })
```

### create_reply_draft

Save a reply to an existing email as a draft. Fills in the recipients (Reply-To if set, otherwise the sender), a `Re:` subject, and the `In-Reply-To`/`References` headers so the reply stays in the same thread. **Nothing is sent.**

**Parameters:**
- `uid` (required): UID of the email being replied to
- `body` (required): Reply text (written above the quoted original)
- `folder` (optional): Folder containing the original (default: 'INBOX')
- `replyAll` (optional): Also reply to the original's To and Cc, excluding your own address (default: false)
- `includeQuote` (optional): Quote the original below the reply (default: true)
- `html` (optional), `attachments` (optional): As in `create_draft`

**Example:**
```javascript
create_reply_draft({ uid: 581098, body: "Thanks, I'll review it by Friday.", replyAll: true })
```

### update_draft

Revise a draft. Only the fields you pass change; recipients, subject, reply threading, and attachments are otherwise kept. IMAP can't edit a message in place, so the new version is saved and the old one is removed (with `UID EXPUNGE`, which removes only that draft; servers without UIDPLUS move it to Trash instead).

**The draft gets a new UID on every update.** Always use the UID from the latest create/update result.

**Parameters:**
- `uid` (required): UID of the draft to revise
- `to`, `cc`, `bcc` (optional): Replace the address lists (`[]` clears Cc/Bcc)
- `subject`, `body` (optional): Replace the subject or the whole body
- `html` (optional): Replace the HTML body (`""` removes it)
- `addAttachments` (optional): Paths of local files to add
- `removeAttachments` (optional): Filenames of attachments to remove

**Example (revising from feedback):**
```javascript
// "Make it more formal and cc my manager"
update_draft({ uid: 395417, body: "Dear Jane, ...", cc: ["manager@example.com"] })
// → returns the full revised draft and its new UID (e.g. 395418)
```

## Performance Considerations

### Render.com Free Tier

- **Sleep after inactivity**: Services sleep after 15 minutes of no requests
- **Wake-up time**: First request takes 30-60 seconds
- **Monthly hours**: 750 hours/month (enough for moderate use)
- **Upgrade**: $7/month for Starter plan (always-on)

### IMAP Performance

- **Shared connection**: Tool calls reuse one IMAP login and take turns on it; the connection logs out after `IMAP_IDLE_MS` (default 5 minutes) without use and reconnects on the next call
- **Timeout**: 30 seconds for connection and auth
- **Rate limiting**: Yahoo may throttle excessive requests
- **Recommendation**: Cache results on client side when possible

## Cross-Platform Compatibility

This project is designed to work seamlessly on:

- **Windows 10/11** with PowerShell or Command Prompt
- **Linux** (Ubuntu, Debian, Fedora, etc.)
- **macOS** (Intel and Apple Silicon)
- **Docker Desktop** (Windows, Mac, Linux)
- **WSL2** (Windows Subsystem for Linux)

### Line Endings

- `.gitattributes` ensures LF line endings in repository
- Works correctly on Windows (CRLF) and Linux (LF)
- Docker uses LF inside containers

### Path Handling

- All paths use forward slashes in code
- `path.join()` used for cross-platform compatibility
- Works with Windows backslashes and Unix forward slashes

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Test on both Windows and Linux (if possible)
5. Commit: `git commit -am "Add feature"`
6. Push: `git push origin feature-name`
7. Create a Pull Request

## License

MIT License. See the [LICENSE](LICENSE) file. Original work © jtokib; modifications © praneethpalla.

## Support

- **Issues**: Report bugs at https://github.com/praneethpalla/yahoo-mail-mcp/issues
- **Discussions**: Ask questions in GitHub Discussions
- **MCP Docs**: https://modelcontextprotocol.io

## Changelog

### v3.1.0 (2026-09-26) - Drafts, Attachments, Streamable HTTP

**New Features:**
- New tools: `download_attachments`, `create_draft`, `create_reply_draft`, `update_draft` (drafts are never sent)
- `read_email` lists attachments (name, type, size) and returns emails in the requested order
- Streamable HTTP transport at `POST /mcp` (stateless, JSON replies) for current MCP clients; legacy SSE kept at `/mcp/sse`; `TRANSPORT_MODE=http`
- One shared IMAP login across tool calls, with idle logout (`IMAP_IDLE_MS`)
- Bulk flag/read/archive/move run as one IMAP command after checking which UIDs exist
- `ENV_FILE`, `DRAFTS_FOLDER`, and `OAUTH_REDIRECT_HOSTS` settings; `.env` is loaded from next to `server.js`
- Offline test suite (`npm test`)

**Bug Fixes:**
- `read_email` returned empty text for large emails, and returned only the first of several UIDs
- `size` was always 0 in list/search/read results
- Invalid search dates were silently ignored; they now return an error before logging in
- Error results now set `isError`
- Message bodies are buffered as bytes, so binary content isn't corrupted

**Security:**
- Sign-in page for OAuth authorization: previously `/oauth/authorize` issued a code to anyone without asking. It now requires a username, password (scrypt hash), and optional authenticator code (TOTP), with single-use codes and a 15-minute lockout after 5 failures
- `client_credentials` grant is off by default (`ALLOW_CLIENT_CREDENTIALS=true` to enable)
- OAuth `redirect_uri` is checked by exact hostname over https. The previous substring check accepted URLs like `https://evil.example/?claude.ai`
- Access tokens were never expired (despite `expires_in: 3600`), were stored only in memory (lost on every restart), and were built from `Math.random()` with the client ID in plain base64. They are now signed, expiring tokens with random IDs, plus single-use refresh tokens (`refresh_token` grant)
- Authorization codes are random (`crypto.randomBytes`), expire after 60 seconds, and must match the original `redirect_uri`; a missing PKCE verifier returns an error instead of crashing
- Client secrets are compared in constant time, and secrets containing `:` work with Basic auth
- HTTP mode refuses to start without OAuth credentials

### v3.0.0 (2025-01-18) - UID Migration

**BREAKING CHANGES:**
- All tools now use `uids` parameter instead of `sequenceNumbers`
- Response format changed from plain text to structured JSON
- UIDs are permanent identifiers that don't change when emails are deleted

**New Features:**
- Enriched metadata: All emails include `uid`, `size`, `flags`, `hasAttachments`
- Pagination support: `list_emails` accepts `offset` and `limit` parameters
- Advanced search filters: `dateFrom`, `dateTo`, `sender`, `unreadOnly` parameters
- Folder support: All tools accept `folder` parameter (default: INBOX)
- New tool: `list_folders` to discover available IMAP folders
- Enhanced error handling: Better timeout and connection error messages with Render spindown detection

**Bug Fixes:**
- **CRITICAL**: Fixed batch operations bug where only first UID was processed
- All batch operations now accurately process every UID in the array
- Success/failure messages now report exact counts of processed emails

**Migration Guide:**
- Replace `sequenceNumbers` with `uids` in all tool calls
- Get UIDs from `list_emails` or `search_emails` responses
- Update code to handle JSON responses instead of plain text
- See "Breaking Changes & Migration Guide" section above for details

### v2.0.1 (2025-01-17)

- Fixed: Enhanced input validation for all email operations
- Added shared validation helper to prevent IMAP errors with invalid sequence numbers
- Improved error messages for better debugging

### v2.0.0 (2025-01-16)

- **Breaking Change**: `read_email` now uses `sequenceNumbers` (array) instead of `sequenceNumber` (single number)
- Added full email management with batch operations support
- Seven new tools: delete_emails, archive_emails, mark_as_read, mark_as_unread, flag_emails, unflag_emails, move_emails
- All modification operations support batch processing
- Enhanced security with reversible operations (soft delete, no permanent deletion)

### v1.0.0 (2025-01-11)

- Initial release
- Support for stdio and SSE transports
- Docker and Docker Compose support
- Render.com deployment configuration
- Cross-platform compatibility (Windows/Linux)
- Three core tools: list_emails, read_email, search_emails

## Acknowledgments

- Based on [jtokib/yahoo-mail-mcp-server](https://github.com/jtokib/yahoo-mail-mcp-server) (MIT), extended with draft and attachment tools, Streamable HTTP, connection reuse, and bug fixes (see Changelog v3.1.0)
- Built with [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)
- Uses [imap](https://github.com/mscdex/node-imap) for IMAP access
- Uses [mailparser](https://github.com/nodemailer/mailparser) for email parsing
- Deployed on [Render.com](https://render.com)

## FAQ

### Q: Can I use this with Gmail or other email providers?

A: Currently, this server is configured for Yahoo Mail. To support other providers, change the IMAP host settings in `openImapConnection()` in `server.js`.

### Q: Is this safe to use with my email account?

A: See [Where Your Credentials Live](#where-your-credentials-live-read-this-first) for exactly who can see what in local and hosted setups. In short: The server uses app-specific passwords (not your main password) and never sends email on your behalf; it only saves drafts. Delete operations move emails to Trash (recoverable). The one permanent removal is in `update_draft`, which removes the previous version of the draft being revised (and only that draft).

### Q: How much does it cost to run on Render?

A: The free tier provides 750 hours/month, which is enough for moderate use. For always-on service, the Starter plan is $7/month.

### Q: Can I run this on other cloud platforms?

A: Yes! The Docker configuration works on any platform that supports Docker containers (AWS ECS, Google Cloud Run, Azure Container Instances, Heroku, Fly.io, etc.).

### Q: Do I need to keep my computer running?

A: No! Once deployed to Render.com (or another cloud platform), the server runs independently in the cloud.

### Q: How do I update the server after deployment?

A: Simply push your changes to GitHub. Render automatically detects the push and redeploys the service.

### Q: Can multiple people use the same deployed server?

A: The server connects to a single Yahoo Mail account (the one configured in environment variables). Each user would need their own deployment for their own email account.

### Q: What if I forget my app-specific password?

A: You can generate a new one at https://login.yahoo.com/account/security/app-passwords and update it in your Render environment variables (Settings > Environment).

## Next Steps

After successful deployment:

1. ✅ Test the health endpoint
2. ✅ Connect to Claude.ai
3. ✅ Try listing your emails
4. ✅ Read a few emails
5. ✅ Search your inbox
6. 🎉 Enjoy your Yahoo Mail MCP server!

---

**Happy Coding!** If you have questions or issues, please open an issue on GitHub.
