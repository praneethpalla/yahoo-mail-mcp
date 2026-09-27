#!/usr/bin/env node

/**
 * Yahoo Mail MCP Server
 * Reads and organizes Yahoo Mail over IMAP (app password), downloads attachments, and saves drafts
 * (never sends). Transports: stdio for local clients; Streamable HTTP (/mcp) and legacy SSE (/mcp/sse),
 * protected by OAuth 2.0, for remote clients.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs/promises';

// Load environment variables from .env file (for local development)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ENV_FILE lets tests point at a separate account (e.g. ENV_FILE=.env.test) without touching .env
dotenv.config({ path: path.resolve(__dirname, process.env.ENV_FILE || '.env'), quiet: true });

class YahooMailMCPServer {
    constructor() {
        // MCP server object for stdio and SSE; Streamable HTTP creates one per request
        this.server = this.createMcpServer();

        // Store active SSE transports (for routing messages)
        this.transports = new Map();

        // OAuth access/refresh tokens are signed (see issueToken), so they need no storage and survive
        // restarts. Only these short-lived items are kept in memory:
        this.authCodes = new Map();          // authorization codes, valid for 60 seconds
        this.usedRefreshTokens = new Map();  // refresh token id -> expiry, so each refresh token works once

        // Shared IMAP connection, reused across tool calls to avoid logging in on every call
        // (Yahoo throttles frequent logins). Calls take turns via imapLock because each one
        // selects its own folder on the same connection.
        this.imapConn = null;
        this.imapLock = Promise.resolve();
        this.imapIdleTimer = null;

        this.setupErrorHandling();
    }

    /**
     * Create an MCP server object with all tool handlers registered.
     * An MCP server object serves one transport at a time, so stateless HTTP makes a new one per request;
     * they all share this instance's IMAP connection.
     */
    createMcpServer() {
        const server = new Server(
            {
                name: 'yahoo-mail-mcp',
                version: '3.1.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );
        this.setupToolHandlers(server);
        server.onerror = (error) => {
            console.error('[MCP Error]', error);
        };
        return server;
    }

    /**
     * Setup MCP tool handlers
     */
    setupToolHandlers(server) {
        // Handle tool listing
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'list_emails',
                        description: 'List recent emails from a Yahoo Mail folder. Returns UIDs (permanent identifiers) and enriched metadata including size, flags, and attachment status.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                count: {
                                    type: 'number',
                                    description: 'Number of emails to retrieve (default: 10, max: 50)',
                                    default: 10
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to list emails from (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                offset: {
                                    type: 'number',
                                    description: 'Number of emails to skip (for pagination, default: 0)',
                                    default: 0
                                }
                            }
                        }
                    },
                    {
                        name: 'read_email',
                        description: 'Read email content using UIDs (permanent identifiers). UIDs don\'t change when emails are deleted. Get UIDs from list_emails or search_emails.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to read. UIDs are permanent identifiers from list_emails.',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'search_emails',
                        description: 'Search emails using UIDs with advanced filters. Returns UIDs which are permanent identifiers that don\'t change when emails are deleted. Get UIDs from results for subsequent operations.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Search term for subject or sender (can be empty for date-only searches)',
                                    default: ''
                                },
                                count: {
                                    type: 'number',
                                    description: 'Number of results to return (default: 10, max: 50)',
                                    default: 10
                                },
                                dateFrom: {
                                    type: 'string',
                                    description: 'Filter emails from this date onwards (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                dateTo: {
                                    type: 'string',
                                    description: 'Filter emails up to this date (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                sender: {
                                    type: 'string',
                                    description: 'Filter by specific sender email address or name',
                                    default: null
                                },
                                unreadOnly: {
                                    type: 'boolean',
                                    description: 'Only return unread emails (default: false)',
                                    default: false
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to search in (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                }
                            },
                            required: []
                        }
                    },
                    {
                        name: 'delete_emails',
                        description: 'Move emails to Trash folder using UIDs (soft delete, recoverable). UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to delete',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'archive_emails',
                        description: 'Move emails to Archive folder using UIDs for long-term storage. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to archive',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_read',
                        description: 'Mark emails as read using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as read',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_unread',
                        description: 'Mark emails as unread using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as unread',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'flag_emails',
                        description: 'Flag emails as important/starred using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to flag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'unflag_emails',
                        description: 'Remove flag/star from emails using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to unflag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'move_emails',
                        description: 'Move emails to a specified folder using UIDs. UIDs are permanent identifiers. Use list_folders to see available folders.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to move',
                                    minItems: 1
                                },
                                folderName: {
                                    type: 'string',
                                    description: 'Name of the destination folder (e.g., "Work", "Personal"). Use list_folders to see available folders.'
                                },
                                sourceFolder: {
                                    type: 'string',
                                    description: 'Source folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids', 'folderName']
                        }
                    },
                    {
                        name: 'download_attachments',
                        description: 'Download attachments from an email (by UID) and save them to disk. Returns the saved file paths. Use read_email to see attachment names first.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: {
                                    type: 'number',
                                    description: 'UID of the email containing the attachments'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                filenames: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Only download attachments with these filenames (default: all attachments)'
                                },
                                saveDir: {
                                    type: 'string',
                                    description: 'Directory to save attachments to (default: ~/Downloads/yahoo-attachments)'
                                }
                            },
                            required: ['uid']
                        }
                    },
                    {
                        name: 'create_draft',
                        description: 'Create a new email draft and save it to the Yahoo Mail Drafts folder. The email is NOT sent; the user reviews and sends it from Yahoo Mail. Returns the full draft and its UID. To revise the draft later, call update_draft with that UID.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                to: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Recipient address(es), e.g. ["Jane <jane@example.com>", "b@example.com"]'
                                },
                                cc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional Cc address(es)'
                                },
                                bcc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional Bcc address(es)'
                                },
                                subject: { type: 'string', description: 'Subject line' },
                                body: { type: 'string', description: 'Plain-text body of the email' },
                                html: { type: 'string', description: 'Optional HTML version of the body. If omitted, the email is plain text only.' },
                                attachments: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional paths of local files to attach (e.g. files saved by download_attachments)'
                                }
                            },
                            required: ['to', 'subject', 'body']
                        }
                    },
                    {
                        name: 'create_reply_draft',
                        description: 'Create a reply to an existing email (by UID) and save it as a draft. Fills in the recipients, "Re:" subject, and threading headers so the reply stays in the same conversation. The email is NOT sent. Returns the full draft and its UID; use update_draft with that UID to revise it.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: { type: 'number', description: 'UID of the email being replied to (from list_emails or search_emails)' },
                                folder: { type: 'string', description: 'Folder containing the original email (default: INBOX)', default: 'INBOX' },
                                body: { type: 'string', description: 'Plain-text reply text (written above the quoted original)' },
                                html: { type: 'string', description: 'Optional HTML version of the reply text' },
                                replyAll: { type: 'boolean', description: 'Also reply to everyone in To and Cc of the original (default: false)', default: false },
                                includeQuote: { type: 'boolean', description: 'Quote the original message below the reply (default: true)', default: true },
                                attachments: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional paths of local files to attach'
                                }
                            },
                            required: ['uid', 'body']
                        }
                    },
                    {
                        name: 'update_draft',
                        description: 'Revise an existing draft in the Drafts folder. Only the fields you pass are changed; everything else (recipients, subject, reply threading, attachments) is kept. IMPORTANT: the draft gets a NEW UID on every update. Always use the UID returned by the most recent create/update call. The old version is removed. The email is NOT sent.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: { type: 'number', description: 'UID of the draft to revise (from the latest create_draft, create_reply_draft, or update_draft result)' },
                                to: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'New recipient address(es) (replaces the existing list)'
                                },
                                cc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'New Cc address(es) (replaces the existing list; pass [] to clear)'
                                },
                                bcc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'New Bcc address(es) (replaces the existing list; pass [] to clear)'
                                },
                                subject: { type: 'string', description: 'New subject line' },
                                body: { type: 'string', description: 'New plain-text body (replaces the whole body)' },
                                html: { type: 'string', description: 'New HTML body. Pass an empty string to remove the HTML version.' },
                                addAttachments: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Paths of local files to add as attachments'
                                },
                                removeAttachments: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Filenames of existing attachments to remove'
                                }
                            },
                            required: ['uid']
                        }
                    },
                    {
                        name: 'list_folders',
                        description: 'List all available IMAP folders/mailboxes in your Yahoo Mail account',
                        inputSchema: {
                            type: 'object',
                            properties: {}
                        }
                    }
                ]
            };
        });

        // Handle tool execution
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'list_emails':
                        return await this.listEmails(args?.count || 10, args?.folder || 'INBOX', args?.offset || 0);

                    case 'read_email':
                        return await this.readEmail(args.uids, args.folder);

                    case 'search_emails':
                        return await this.searchEmails(args?.query || '', {
                            count: args?.count || 10,
                            dateFrom: args?.dateFrom || null,
                            dateTo: args?.dateTo || null,
                            sender: args?.sender || null,
                            unreadOnly: args?.unreadOnly || false,
                            folder: args?.folder || 'INBOX'
                        });

                    case 'delete_emails':
                        return await this.deleteEmails(args.uids, args.folder);

                    case 'archive_emails':
                        return await this.archiveEmails(args.uids, args.folder);

                    case 'mark_as_read':
                        return await this.markAsRead(args.uids, args.folder);

                    case 'mark_as_unread':
                        return await this.markAsUnread(args.uids, args.folder);

                    case 'flag_emails':
                        return await this.flagEmails(args.uids, args.folder);

                    case 'unflag_emails':
                        return await this.unflagEmails(args.uids, args.folder);

                    case 'move_emails':
                        return await this.moveEmails(args.uids, args.folderName, args.sourceFolder);

                    case 'list_folders':
                        return await this.listFolders();

                    case 'download_attachments':
                        return await this.downloadAttachments(args.uid, args.folder, args.filenames, args.saveDir);

                    case 'create_draft':
                        return await this.createDraft(args);

                    case 'create_reply_draft':
                        return await this.createReplyDraft(args);

                    case 'update_draft':
                        return await this.updateDraft(args);

                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error.message}`
                        }
                    ],
                    isError: true
                };
            }
        });
    }

    /**
     * Get the shared IMAP connection for one tool call.
     *
     * Waits until the previous call is done, then returns the connection. Calling end() on the
     * returned object hands the connection to the next call instead of logging out; the real
     * connection logs out after IMAP_IDLE_MS of no use.
     */
    async createImapConnection() {
        let release;
        const previous = this.imapLock;
        this.imapLock = new Promise(resolve => { release = resolve; });
        await previous;
        clearTimeout(this.imapIdleTimer);

        let conn;
        try {
            conn = await this.getSharedConnection();
        } catch (err) {
            release();
            throw err;
        }

        let released = false;
        const done = () => {
            if (released) return;
            released = true;
            clearTimeout(safetyTimer);
            this.scheduleIdleLogout();
            release();
        };
        // Safety net: never let one stuck call block every later call
        const safetyTimer = setTimeout(() => {
            console.error('[IMAP] Connection held for over 5 minutes; releasing it');
            done();
        }, 5 * 60 * 1000);

        return new Proxy(conn, {
            get: (target, prop) => {
                if (prop === 'end') return done;
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    /**
     * Return the logged-in shared connection, logging in again if it was closed or dropped
     */
    async getSharedConnection() {
        if (this.imapConn && this.imapConn.state === 'authenticated') {
            return this.imapConn;
        }

        this.imapConn = null;
        const conn = await this.openImapConnection();
        const drop = () => {
            if (this.imapConn === conn) this.imapConn = null;
        };
        // A persistent listener is required: an 'error' with no listener would crash the process
        conn.on('error', (err) => {
            console.error('[IMAP] Shared connection error:', err.message);
            drop();
        });
        conn.once('end', drop);
        conn.once('close', drop);
        this.imapConn = conn;
        return conn;
    }

    /**
     * Log out of the shared connection after a period of no use
     */
    scheduleIdleLogout() {
        clearTimeout(this.imapIdleTimer);
        const idleMs = Number(process.env.IMAP_IDLE_MS) || 5 * 60 * 1000;
        this.imapIdleTimer = setTimeout(() => {
            if (this.imapConn) {
                console.error('[IMAP] Logging out after idle period');
                this.imapConn.end();
                this.imapConn = null;
            }
        }, idleMs);
        this.imapIdleTimer.unref?.();
    }

    /**
     * Open a new IMAP connection using app-specific password (like the working test script)
     */
    async openImapConnection() {
        return new Promise((resolve, reject) => {
            if (!process.env.YAHOO_EMAIL || !process.env.YAHOO_APP_PASSWORD) {
                const error = new Error('YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variables are not set');
                console.error('[IMAP] Configuration error:', error.message);
                reject(error);
                return;
            }

            const imap = new Imap({
                user: process.env.YAHOO_EMAIL,
                password: process.env.YAHOO_APP_PASSWORD,
                host: 'imap.mail.yahoo.com',
                port: 993,
                tls: true,
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: true,
                    servername: 'imap.mail.yahoo.com',
                    minVersion: 'TLSv1.2'
                }
            });

            // Add connection timeout handler (35 seconds)
            const connectionTimeout = setTimeout(() => {
                console.error('[IMAP] Connection timeout after 35 seconds');
                imap.end();
                reject(new Error('Connection timed out. Service may have been sleeping (Render spindown). Please try again.'));
            }, 35000);

            imap.once('ready', () => {
                clearTimeout(connectionTimeout);
                resolve(imap);
            });

            imap.once('error', (err) => {
                clearTimeout(connectionTimeout);
                console.error('[IMAP] Connection error:', err.message);

                // Provide enhanced error messages based on error type
                let errorMessage = err.message;

                // Authentication errors
                if (err.message.includes('Invalid credentials') ||
                    err.message.includes('authentication failed') ||
                    err.message.includes('AUTHENTICATIONFAILED')) {
                    errorMessage = `Authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
                }
                // Network/connection errors
                else if (err.message.includes('ENOTFOUND') ||
                         err.message.includes('ECONNREFUSED') ||
                         err.message.includes('ETIMEDOUT') ||
                         err.message.includes('getaddrinfo')) {
                    errorMessage = `Cannot connect to Yahoo Mail servers: ${err.message}. Check internet connection.`;
                }
                // Timeout errors
                else if (err.message.includes('Timed out') ||
                         err.message.includes('timeout')) {
                    errorMessage = `Connection timed out: ${err.message}. Service may have been sleeping (Render spindown). Please try again.`;
                }

                reject(new Error(errorMessage));
            });

            imap.connect();
        });
    }

    /**
     * List recent emails with enriched metadata
     */
    async listEmails(count = 10, folder = 'INBOX', offset = 0) {
        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }],
                isError: true
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (use search or filters for larger results)'
                }],
                isError: true
            };
        }

        // Validate offset
        if (offset < 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: offset must be non-negative'
                }],
                isError: true
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const total = box.messages.total;

                if (total === 0) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: 0,
                                offset: 0,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Calculate range with offset
                // If total=100, offset=10, count=10: fetch messages 81-90 (reversed for newest first)
                const startSeq = Math.max(1, total - offset - count + 1);
                const endSeq = Math.max(1, total - offset);

                if (startSeq > endSeq) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder,
                                message: 'Offset exceeds available messages'
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Fetch with struct for attachments and size
                const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, {
                    bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                    struct: true,
                    size: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    let header = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            header += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(header);

                        emails.push({
                            uid: attrs.uid,                          // NEW: Permanent UID
                            sequenceNumber: seqno,                   // Legacy reference
                            from: parsed.from?.[0] || 'Unknown',
                            subject: parsed.subject?.[0] || 'No Subject',
                            date: parsed.date?.[0] || 'Unknown Date',
                            size: attrs.size || 0,                   // NEW: Message size in bytes
                            flags: attrs.flags || [],                // NEW: IMAP flags
                            hasAttachments: this.hasAttachments(attrs.struct) // NEW
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    // Sort by sequence number (newest first)
                    emails.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: emails,
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                });
            });
        });
    }

    /**
     * Read specific emails by UIDs (supports batch reading)
     */
    async readEmail(uids, folder = 'INBOX') {
        // Support both single number and array for backward compatibility
        if (!Array.isArray(uids)) {
            uids = [uids];
        }

        return this.readEmails(uids, folder);
    }

    /**
     * Search emails with advanced filters
     */
    async searchEmails(query, options = {}) {
        const {
            count = 10,
            dateFrom = null,
            dateTo = null,
            sender = null,
            unreadOnly = false,
            folder = 'INBOX'
        } = options;

        // Validate query parameter (allow empty for date-only searches)
        if (query === undefined || query === null) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: query is required (use empty string "" for searches without text criteria)'
                }],
                isError: true
            };
        }

        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }],
                isError: true
            };
        }

        // Validate dates before connecting, so a typo doesn't cost a login.
        // new Date() never throws on bad input; it returns an Invalid Date.
        const fromDate = dateFrom ? new Date(dateFrom) : null;
        const toDate = dateTo ? new Date(dateTo) : null;
        for (const [name, value, date] of [['dateFrom', dateFrom, fromDate], ['dateTo', dateTo, toDate]]) {
            if (date && isNaN(date.getTime())) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Invalid ${name} format: "${value}". Use ISO 8601 (e.g. 2026-09-01) or RFC 2822 format.`
                    }],
                    isError: true
                };
            }
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Build search criteria
                const criteria = [];

                // Text search (subject or from)
                if (query && query.trim().length > 0) {
                    criteria.push([
                        'OR',
                        ['HEADER', 'SUBJECT', query],
                        ['HEADER', 'FROM', query]
                    ]);
                }

                // Sender filter
                if (sender && sender.trim().length > 0) {
                    criteria.push(['HEADER', 'FROM', sender]);
                }

                // Date range filters
                if (fromDate) {
                    criteria.push(['SINCE', fromDate]);
                }

                if (toDate) {
                    criteria.push(['BEFORE', toDate]);
                }

                // Unread only filter
                if (unreadOnly) {
                    criteria.push('UNSEEN');
                }

                // If no criteria, search all
                if (criteria.length === 0) {
                    criteria.push('ALL');
                }

                // CRITICAL: imap.search() returns UIDs by default (NOT sequence numbers)
                imap.search(criteria, (err, results) => {
                    if (err) {
                        imap.end();
                        reject(err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: [],
                                    totalMatches: 0,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                        return;
                    }

                    // Get the most recent results (UIDs are already sorted)
                    const limitedResults = results.slice(-count);

                    // Fetch details for these UIDs
                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                        struct: true,
                        size: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        let header = '';
                        let attrs = null;

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                header += chunk.toString('ascii');
                            });
                        });

                        msg.once('attributes', (attributes) => {
                            attrs = attributes;
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(header);
                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,
                                from: parsed.from?.[0] || 'Unknown',
                                subject: parsed.subject?.[0] || 'No Subject',
                                date: parsed.date?.[0] || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct)
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        imap.end();

                        // Sort by UID (newest first typically)
                        emails.sort((a, b) => b.uid - a.uid);

                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: emails,
                                    totalMatches: results.length,
                                    returned: emails.length,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                    });
                });
            });
        });
    }

    /**
     * Validate sequence numbers array for all email operations
     * @returns {string|null} Error message if invalid, null if valid
     */
    validateSequenceNumbers(sequenceNumbers) {
        if (!sequenceNumbers) {
            return 'sequenceNumbers is required';
        }

        if (!Array.isArray(sequenceNumbers)) {
            return 'sequenceNumbers must be an array';
        }

        if (sequenceNumbers.length === 0) {
            return 'sequenceNumbers cannot be empty';
        }

        const invalidValues = sequenceNumbers.filter(n => n === undefined || n === null || typeof n !== 'number');
        if (invalidValues.length > 0) {
            return 'sequenceNumbers contains invalid values (must be numbers)';
        }

        return null;
    }

    /**
     * Helper method for batch email modification operations using UIDs
     *
     * With bulk: true (default), existing UIDs are looked up first and the operation runs as a
     * single IMAP command, since servers report OK for bulk commands even when some UIDs don't exist.
     * Falls back to one UID at a time if the bulk command fails. bulk: false always goes one at a time.
     */
    async modifyEmails(uids, operation, operationName, folder = 'INBOX', { bulk = true } = {}) {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, false, (err, box) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const successfulUIDs = [];
                const failedUIDs = [];
                let pendingUIDs = uids;
                let processedCount = 0;

                // Process each UID individually to ensure all are processed
                const processNextUID = () => {
                    if (processedCount >= pendingUIDs.length) {
                        // All UIDs processed
                        imap.end();

                        if (failedUIDs.length === uids.length) {
                            // All failed
                            reject(new Error(`None of the ${failedUIDs.length} email(s) could be ${operationName}. UIDs may not exist: ${failedUIDs.join(', ')}`));
                        } else if (successfulUIDs.length > 0) {
                            // At least some succeeded
                            const message = failedUIDs.length > 0
                                ? `Successfully ${operationName} ${successfulUIDs.length} of ${uids.length} email(s). ` +
                                  `Successful: ${successfulUIDs.join(', ')}. Failed: ${failedUIDs.join(', ')}`
                                : `Successfully ${operationName} ${successfulUIDs.length} email(s) with UIDs: ${successfulUIDs.join(', ')}`;

                            resolve({
                                content: [{
                                    type: 'text',
                                    text: message
                                }]
                            });
                        } else {
                            reject(new Error(`No emails could be ${operationName}`));
                        }
                        return;
                    }

                    const uid = pendingUIDs[processedCount];
                    processedCount++;

                    // Execute the UID-based operation for this single UID
                    operation(imap, uid.toString(), (err) => {
                        if (err) {
                            console.error(`[UID ${uid}] Failed to ${operationName}:`, err.message);
                            failedUIDs.push(uid);
                        } else {
                            successfulUIDs.push(uid);
                        }

                        // Continue to next UID (don't stop on errors)
                        processNextUID();
                    });
                };

                if (!bulk) {
                    processNextUID();
                    return;
                }

                // Find which of the requested UIDs exist in this folder
                imap.search([['UID', ...uids]], (err, existing) => {  // spread: node-imap reads each element after 'UID' as one value
                    if (err) {
                        console.error(`[Bulk] UID lookup failed, processing one at a time:`, err.message);
                        processNextUID();
                        return;
                    }

                    const existingSet = new Set(existing);
                    failedUIDs.push(...uids.filter(uid => !existingSet.has(uid)));
                    const found = uids.filter(uid => existingSet.has(uid));

                    if (found.length === 0) {
                        processedCount = pendingUIDs.length;  // nothing left to do; report results
                        processNextUID();
                        return;
                    }

                    // Pass an array: node-imap only uses the first UID of a comma-joined string
                    operation(imap, found, (err) => {
                        if (err) {
                            console.error(`[Bulk] Failed to ${operationName}, processing one at a time:`, err.message);
                            pendingUIDs = found;
                            processNextUID();
                            return;
                        }
                        successfulUIDs.push(...found);
                        processedCount = pendingUIDs.length;
                        processNextUID();
                    });
                });
            });
        });
    }

    /**
     * Helper method for reading multiple emails using UIDs
     */
    async readEmails(uids, folder = 'INBOX') {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Pass an array: node-imap only fetches the first UID of a comma-joined string
                const source = uids;

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(source, {
                    bodies: '',
                    struct: true,
                    size: true
                });

                const emails = [];
                const foundUIDs = new Set();
                const parsing = [];  // simpleParser is async; wait for all parses before returning

                fetch.on('message', (msg, seqno) => {
                    const chunks = [];
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                        foundUIDs.add(attributes.uid);
                    });

                    msg.once('end', () => {
                        parsing.push(simpleParser(Buffer.concat(chunks)).then((parsed) => {

                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,  // Still include for reference
                                from: parsed.from?.text || 'Unknown',
                                to: parsed.to?.text || 'Unknown',
                                subject: parsed.subject || 'No Subject',
                                date: parsed.date || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct),
                                attachments: (parsed.attachments || []).map(a => `${a.filename || 'unnamed'} (${a.contentType}, ${a.size} bytes)`),
                                content: parsed.text || parsed.html || 'No content available'
                            });
                        }).catch((err) => {
                            console.error('Error parsing email:', err);
                        }));
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', async () => {
                    imap.end();
                    await Promise.all(parsing);

                    // Check for missing UIDs
                    const missingUIDs = uids.filter(uid => !foundUIDs.has(uid));
                    if (missingUIDs.length > 0) {
                        reject(new Error(
                            `UIDs not found: ${missingUIDs.join(', ')}. ` +
                            `Found ${emails.length} of ${uids.length} requested emails. ` +
                            `Missing UIDs may have been deleted or moved to another folder.`
                        ));
                        return;
                    }

                    // Return emails in the order they were requested (the server returns them by UID)
                    emails.sort((a, b) => uids.indexOf(a.uid) - uids.indexOf(b.uid));

                    // Format output
                    const emailContent = emails.map(email =>
                        `📧 Email UID: ${email.uid} (Seq #${email.sequenceNumber})\n\n` +
                        `From: ${email.from}\n` +
                        `To: ${email.to}\n` +
                        `Subject: ${email.subject}\n` +
                        `Date: ${email.date}\n` +
                        `Size: ${email.size} bytes\n` +
                        `Flags: ${email.flags.join(', ') || 'None'}\n` +
                        `Has Attachments: ${email.hasAttachments ? 'Yes' : 'No'}\n` +
                        (email.attachments.length ? `Attachments:\n${email.attachments.map(a => `  - ${a}`).join('\n')}\n` : '') +
                        `\n` +
                        `--- Content ---\n` +
                        `${email.content}`
                    ).join('\n\n' + '='.repeat(80) + '\n\n');

                    resolve({
                        content: [{
                            type: 'text',
                            text: emailContent
                        }]
                    });
                });
            });
        });
    }

    /**
     * Download attachments from a single email and save them to disk
     */
    async downloadAttachments(uid, folder = 'INBOX', filenames = null, saveDir = null) {
        const validationError = this.validateUIDs([uid]);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const targetDir = saveDir
            ? path.resolve(saveDir.replace(/^~(?=$|\/)/, os.homedir()))
            : path.join(os.homedir(), 'Downloads', 'yahoo-attachments');

        const raw = await this.fetchRawEmail(uid, folder);
        const parsed = await simpleParser(raw);
        let attachments = parsed.attachments || [];

        if (attachments.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `Email UID ${uid} has no attachments.`
                }]
            };
        }

        if (filenames && filenames.length > 0) {
            const wanted = new Set(filenames);
            attachments = attachments.filter(a => wanted.has(a.filename));
            if (attachments.length === 0) {
                const available = (parsed.attachments || []).map(a => a.filename || 'unnamed').join(', ');
                return {
                    content: [{
                        type: 'text',
                        text: `Error: None of the requested filenames were found. Available attachments: ${available}`
                    }],
                    isError: true
                };
            }
        }

        await fs.mkdir(targetDir, { recursive: true });

        const saved = [];
        for (const [index, attachment] of attachments.entries()) {
            // Strip any path components and unsafe characters from the attachment name
            const baseName = path.basename(attachment.filename || `attachment-${index + 1}`)
                .replace(/[\x00-\x1f<>:"|?*]/g, '_') || `attachment-${index + 1}`;
            const filePath = await this.uniqueFilePath(targetDir, baseName);
            await fs.writeFile(filePath, attachment.content);
            saved.push(`  - ${filePath} (${attachment.contentType}, ${attachment.size} bytes)`);
        }

        return {
            content: [{
                type: 'text',
                text: `Saved ${saved.length} attachment(s) from email UID ${uid} ("${parsed.subject || 'No Subject'}"):\n${saved.join('\n')}`
            }]
        };
    }

    /**
     * Helper: Fetch the full raw message (RFC 822 bytes) for one UID, without marking it as read
     */
    async fetchRawEmail(uid, folder = 'INBOX') {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const fetch = imap.fetch(uid.toString(), { bodies: '' });
                const chunks = [];
                let found = false;

                fetch.on('message', (msg) => {
                    found = true;
                    msg.on('body', (stream) => {
                        stream.on('data', (chunk) => chunks.push(chunk));
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();
                    if (!found) {
                        reject(new Error(`UID ${uid} not found in folder "${folder}". It may have been deleted or moved.`));
                        return;
                    }
                    resolve(Buffer.concat(chunks));
                });
            });
        });
    }

    /**
     * Helper: Find the Drafts folder (DRAFTS_FOLDER env, else the folder marked \\Drafts, else "Draft")
     */
    async findDraftsFolder() {
        if (process.env.DRAFTS_FOLDER) return process.env.DRAFTS_FOLDER;
        if (this.draftsFolder) return this.draftsFolder;

        const imap = await this.createImapConnection();
        const boxes = await new Promise((resolve, reject) => {
            imap.getBoxes((err, result) => {
                imap.end();
                if (err) reject(new Error(`Failed to retrieve folders: ${err.message}`));
                else resolve(result);
            });
        });

        const find = (tree, prefix = '') => {
            for (const [name, box] of Object.entries(tree || {})) {
                const fullName = prefix + name;
                if (box.special_use_attrib === '\\Drafts' || (box.attribs || []).includes('\\Drafts')) return fullName;
                const child = find(box.children, fullName + (box.delimiter || '/'));
                if (child) return child;
            }
            return null;
        };

        this.draftsFolder = find(boxes) || 'Draft';
        return this.draftsFolder;
    }

    /**
     * Helper: Normalize a string or array of addresses to a comma-separated string (or undefined)
     */
    formatAddresses(value) {
        if (value === undefined || value === null) return undefined;
        const list = Array.isArray(value) ? value : [value];
        const joined = list.map(a => String(a).trim()).filter(Boolean).join(', ');
        return joined || undefined;
    }

    /**
     * Helper: Build nodemailer attachment entries from local file paths
     */
    async loadAttachmentFiles(paths = []) {
        const files = [];
        for (const filePath of paths) {
            const resolved = path.resolve(filePath.replace(/^~(?=$|\/)/, os.homedir()));
            try {
                files.push({ filename: path.basename(resolved), content: await fs.readFile(resolved) });
            } catch (err) {
                throw new Error(`Cannot read attachment "${filePath}": ${err.message}`);
            }
        }
        return files;
    }

    /**
     * Helper: Build the raw RFC 822 bytes for a draft
     */
    async composeDraft({ from, to, cc, bcc, subject, text, html, attachments, inReplyTo, references }) {
        const mail = new MailComposer({
            from, to, cc, bcc, subject, text,
            html: html || undefined,
            attachments,
            inReplyTo,
            references
        }).compile();
        mail.keepBcc = true;  // drafts must keep Bcc; it is only stripped when actually sending
        return mail.build();
    }

    /**
     * Helper: Save raw message bytes to the Drafts folder and return the new UID
     */
    async appendDraft(raw, draftsFolder) {
        const imap = await this.createImapConnection();
        const messageId = (raw.toString('utf8').match(/^Message-ID:\s*(<[^>]+>)/mi) || [])[1];

        return new Promise((resolve, reject) => {
            imap.append(raw, { mailbox: draftsFolder, flags: ['\\Draft', '\\Seen'] }, (err, newUid) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to save draft to "${draftsFolder}": ${err.message}`));
                    return;
                }
                if (newUid) {
                    imap.end();
                    resolve(newUid);
                    return;
                }

                // Server did not report the new UID (no UIDPLUS): look the draft up by Message-ID
                imap.openBox(draftsFolder, true, (err) => {
                    if (err) {
                        imap.end();
                        reject(new Error(`Draft saved, but could not open "${draftsFolder}" to find its UID: ${err.message}`));
                        return;
                    }
                    imap.search([['HEADER', 'MESSAGE-ID', messageId]], (err, results) => {
                        imap.end();
                        if (err || !results || results.length === 0) {
                            reject(new Error('Draft saved, but its UID could not be determined. Use list_emails on the Drafts folder to find it.'));
                            return;
                        }
                        resolve(Math.max(...results));
                    });
                });
            });
        });
    }

    /**
     * Helper: Remove one old draft version. Uses UID EXPUNGE when supported so only that draft
     * is removed; otherwise moves it to Trash rather than expunging the whole folder.
     */
    async removeDraft(uid, draftsFolder) {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(draftsFolder, false, (err) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open "${draftsFolder}": ${err.message}`));
                    return;
                }

                if (!imap.serverSupports('UIDPLUS')) {
                    imap.move([uid], 'Trash', (err) => {
                        imap.end();
                        if (err) reject(new Error(`New version saved, but the old draft (UID ${uid}) could not be moved to Trash: ${err.message}`));
                        else resolve('moved to Trash');
                    });
                    return;
                }

                imap.addFlags([uid], '\\Deleted', (err) => {
                    if (err) {
                        imap.end();
                        reject(new Error(`New version saved, but the old draft (UID ${uid}) could not be removed: ${err.message}`));
                        return;
                    }
                    imap.expunge([uid], (err) => {
                        imap.end();
                        if (err) reject(new Error(`New version saved, but the old draft (UID ${uid}) could not be removed: ${err.message}`));
                        else resolve('removed');
                    });
                });
            });
        });
    }

    /**
     * Helper: Format a saved draft as text so any MCP client can show it to the user for review
     */
    formatDraftResult(heading, uid, draftsFolder, draft, note = '') {
        const attachmentNames = (draft.attachments || []).map(a => a.filename || 'unnamed');
        return {
            content: [{
                type: 'text',
                text: `${heading}\n` +
                    `Draft UID: ${uid} (folder: ${draftsFolder})\n` +
                    (note ? `${note}\n` : '') +
                    `Status: NOT sent. The user can review and send it from Yahoo Mail Drafts.\n\n` +
                    `To: ${draft.to || '(none)'}\n` +
                    (draft.cc ? `Cc: ${draft.cc}\n` : '') +
                    (draft.bcc ? `Bcc: ${draft.bcc}\n` : '') +
                    `Subject: ${draft.subject || '(no subject)'}\n` +
                    (draft.inReplyTo ? `In-Reply-To: ${draft.inReplyTo}\n` : '') +
                    `Attachments: ${attachmentNames.length ? attachmentNames.join(', ') : 'None'}\n` +
                    `Format: ${draft.html ? 'plain text + HTML' : 'plain text'}\n\n` +
                    `--- Body ---\n${draft.text || ''}`
            }]
        };
    }

    /**
     * Create a new draft
     */
    async createDraft({ to, cc, bcc, subject, body, html, attachments } = {}) {
        const toText = this.formatAddresses(to);
        if (!toText) {
            return { content: [{ type: 'text', text: 'Error: at least one "to" address is required' }], isError: true };
        }

        const draft = {
            from: process.env.YAHOO_EMAIL,
            to: toText,
            cc: this.formatAddresses(cc),
            bcc: this.formatAddresses(bcc),
            subject: subject || '',
            text: body || '',
            html,
            attachments: await this.loadAttachmentFiles(attachments)
        };

        const draftsFolder = await this.findDraftsFolder();
        const newUid = await this.appendDraft(await this.composeDraft(draft), draftsFolder);
        return this.formatDraftResult('Draft created.', newUid, draftsFolder, draft);
    }

    /**
     * Create a reply draft to an existing email
     */
    async createReplyDraft({ uid, folder = 'INBOX', body, html, replyAll = false, includeQuote = true, attachments } = {}) {
        const validationError = this.validateUIDs([uid]);
        if (validationError) {
            return { content: [{ type: 'text', text: `Error: ${validationError}` }], isError: true };
        }

        const original = await simpleParser(await this.fetchRawEmail(uid, folder || 'INBOX'));
        const me = (process.env.YAHOO_EMAIL || '').toLowerCase();
        const addressesOf = (field) => (field?.value || []).filter(a => a.address);
        const fmt = (a) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address);

        // Reply goes to Reply-To if set, otherwise the sender
        const primary = addressesOf(original.replyTo).length ? addressesOf(original.replyTo) : addressesOf(original.from);
        const seen = new Set([me]);
        const pick = (list) => list.filter(a => {
            const key = a.address.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        let toList = pick(primary);
        let ccList = [];
        if (replyAll) {
            toList = toList.concat(pick(addressesOf(original.to)));
            ccList = pick(addressesOf(original.cc));
        }
        if (toList.length === 0) {
            // e.g. replying to your own sent message: fall back to its recipients
            toList = pick(addressesOf(original.to));
        }
        if (toList.length === 0) {
            return { content: [{ type: 'text', text: 'Error: could not determine who to reply to (the original has no usable From, Reply-To, or To address)' }], isError: true };
        }

        const originalSubject = original.subject || '';
        const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;

        let text = body || '';
        if (includeQuote) {
            const when = original.date ? original.date.toUTCString() : 'an earlier date';
            const sender = original.from?.value?.[0];
            const who = sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address) : 'the sender';
            const quoted = (original.text || '').trimEnd().split('\n').map(line => `> ${line}`).join('\n');
            text += `\n\nOn ${when}, ${who} wrote:\n${quoted}\n`;
        }

        const references = []
            .concat(original.references || [])
            .concat(original.messageId ? [original.messageId] : []);

        const draft = {
            from: process.env.YAHOO_EMAIL,
            to: toList.map(fmt).join(', '),
            cc: ccList.length ? ccList.map(fmt).join(', ') : undefined,
            subject,
            text,
            html,
            attachments: await this.loadAttachmentFiles(attachments),
            inReplyTo: original.messageId,
            references: references.length ? references : undefined
        };

        const draftsFolder = await this.findDraftsFolder();
        const newUid = await this.appendDraft(await this.composeDraft(draft), draftsFolder);
        return this.formatDraftResult(`Reply draft created for email UID ${uid}.`, newUid, draftsFolder, draft);
    }

    /**
     * Revise an existing draft: save the new version, then remove the old one
     */
    async updateDraft({ uid, to, cc, bcc, subject, body, html, addAttachments, removeAttachments } = {}) {
        const validationError = this.validateUIDs([uid]);
        if (validationError) {
            return { content: [{ type: 'text', text: `Error: ${validationError}` }], isError: true };
        }

        const draftsFolder = await this.findDraftsFolder();
        const existing = await simpleParser(await this.fetchRawEmail(uid, draftsFolder));

        const removeSet = new Set(removeAttachments || []);
        const keptAttachments = (existing.attachments || [])
            .filter(a => !removeSet.has(a.filename))
            .map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid }));
        const notFound = [...removeSet].filter(name => !(existing.attachments || []).some(a => a.filename === name));
        if (notFound.length > 0) {
            const available = (existing.attachments || []).map(a => a.filename).join(', ') || 'none';
            return { content: [{ type: 'text', text: `Error: attachment(s) not found on this draft: ${notFound.join(', ')}. Current attachments: ${available}` }], isError: true };
        }

        const draft = {
            from: existing.from?.text || process.env.YAHOO_EMAIL,
            to: to !== undefined ? this.formatAddresses(to) : existing.to?.text,
            cc: cc !== undefined ? this.formatAddresses(cc) : existing.cc?.text,
            bcc: bcc !== undefined ? this.formatAddresses(bcc) : existing.bcc?.text,
            subject: subject !== undefined ? subject : existing.subject,
            text: body !== undefined ? body : (existing.text || ''),
            html: html !== undefined ? (html || undefined) : (existing.html || undefined),
            attachments: keptAttachments.concat(await this.loadAttachmentFiles(addAttachments)),
            inReplyTo: existing.inReplyTo,
            references: existing.references
        };
        if (!draft.to) {
            return { content: [{ type: 'text', text: 'Error: the draft must have at least one "to" address' }], isError: true };
        }

        const newUid = await this.appendDraft(await this.composeDraft(draft), draftsFolder);

        let note;
        try {
            const outcome = await this.removeDraft(uid, draftsFolder);
            note = `Previous version (UID ${uid}) ${outcome}.`;
        } catch (err) {
            note = `Warning: ${err.message}`;
        }

        return this.formatDraftResult('Draft updated.', newUid, draftsFolder, draft, note);
    }

    /**
     * Helper: Return a path in dir that doesn't overwrite an existing file (adds " (1)", " (2)", ...)
     */
    async uniqueFilePath(dir, fileName) {
        const ext = path.extname(fileName);
        const stem = path.basename(fileName, ext);
        let candidate = path.join(dir, fileName);
        for (let n = 1; ; n++) {
            try {
                await fs.access(candidate);
                candidate = path.join(dir, `${stem} (${n})${ext}`);
            } catch {
                return candidate;
            }
        }
    }

    /**
     * Mark emails as read
     */
    async markAsRead(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Seen', callback),  // NO .seq
            'marked as read',
            folder
        );
    }

    /**
     * Mark emails as unread
     */
    async markAsUnread(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Seen', callback),  // NO .seq
            'marked as unread',
            folder
        );
    }

    /**
     * Flag emails as important/starred
     */
    async flagEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Flagged', callback),  // NO .seq
            'flagged',
            folder
        );
    }

    /**
     * Remove flag/star from emails
     */
    async unflagEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Flagged', callback),  // NO .seq
            'unflagged',
            folder
        );
    }

    /**
     * Delete emails (move to Trash)
     */
    async deleteEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Trash', callback),  // NO .seq
            'moved to Trash',
            folder,
            { bulk: false }  // deletes stay one email at a time
        );
    }

    /**
     * Archive emails
     */
    async archiveEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Archive', callback),  // NO .seq
            'archived',
            folder
        );
    }

    /**
     * Move emails to a specific folder
     */
    async moveEmails(uids, folderName, sourceFolder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, folderName, callback),  // NO .seq
            `moved to ${folderName}`,
            sourceFolder
        );
    }

    /**
     * Helper: Detect if email has attachments from BODYSTRUCTURE
     */
    hasAttachments(struct) {
        if (!struct || !Array.isArray(struct)) return false;

        // Recursive check for attachment disposition
        const checkPart = (part) => {
            if (!part) return false;

            // Check if this part is an attachment
            if (part.disposition && part.disposition.type === 'attachment') {
                return true;
            }

            // Recursively check sub-parts
            if (Array.isArray(part)) {
                return part.some(p => checkPart(p));
            }

            return false;
        };

        return checkPart(struct);
    }

    /**
     * Helper: Flatten nested folder structure for list_folders
     */
    flattenFolders(boxes, parent = null) {
        const result = [];

        for (const [name, box] of Object.entries(boxes)) {
            const fullName = parent ? `${parent}/${name}` : name;

            // Skip NOSELECT folders (can't select them)
            const isNoSelect = box.attribs && box.attribs.includes('\\Noselect');

            result.push({
                name: fullName,
                delimiter: box.delimiter || '/',
                flags: box.attribs || [],
                selectable: !isNoSelect
            });

            // Recursively process children
            if (box.children) {
                result.push(...this.flattenFolders(box.children, fullName));
            }
        }

        return result;
    }

    /**
     * Helper: Validate UIDs array
     */
    validateUIDs(uids) {
        if (!uids) {
            return 'uids is required';
        }

        if (!Array.isArray(uids)) {
            return 'uids must be an array';
        }

        if (uids.length === 0) {
            return 'uids cannot be empty';
        }

        const invalidValues = uids.filter(n =>
            n === undefined ||
            n === null ||
            typeof n !== 'number' ||
            n <= 0 ||
            !Number.isInteger(n)
        );

        if (invalidValues.length > 0) {
            return 'uids contains invalid values (must be positive integers)';
        }

        return null;
    }

    /**
     * List all available IMAP folders
     */
    async listFolders() {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => {
                imap.end();

                if (err) {
                    reject(new Error(`Failed to retrieve folders: ${err.message}`));
                    return;
                }

                const folders = this.flattenFolders(boxes);

                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            folders: folders,
                            count: folders.length
                        }, null, 2)
                    }]
                });
            });
        });
    }

    setupErrorHandling() {
        process.on('SIGINT', async () => {
            this.imapConn?.end();
            await this.server.close();
            process.exit(0);
        });
    }

    async run() {
        // Check if we should use SSE (HTTP) or stdio transport
        const transportMode = process.env.TRANSPORT_MODE || 'stdio';

        if (transportMode === 'sse' || transportMode === 'http') {
            await this.runSSE();  // serves both Streamable HTTP (/mcp) and legacy SSE (/mcp/sse)
        } else {
            await this.runStdio();
        }
    }

    async runStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Yahoo Mail MCP server running on stdio');
    }

    /**
     * OAuth helper: key for signing tokens, derived from OAUTH_CLIENT_SECRET.
     * Changing the secret invalidates every issued token.
     */
    tokenSigningKey() {
        return crypto.createHash('sha256').update(`yahoo-mail-mcp token signing:${process.env.OAUTH_CLIENT_SECRET}`).digest();
    }

    /**
     * OAuth helper: issue a signed token ("v1.<payload>.<signature>") that expires after ttlSeconds
     */
    issueToken(type, clientId, ttlSeconds, scope = 'mcp') {
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({
            typ: type,
            cid: clientId,
            scope,
            iat: now,
            exp: now + ttlSeconds,
            jti: crypto.randomBytes(16).toString('hex')
        })).toString('base64url');
        const signature = crypto.createHmac('sha256', this.tokenSigningKey()).update(`v1.${payload}`).digest('base64url');
        return `v1.${payload}.${signature}`;
    }

    /**
     * OAuth helper: return the token's payload if the signature, type, client, and expiry are valid; otherwise null
     */
    verifyToken(token, expectedType) {
        if (typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') return null;

        const expected = crypto.createHmac('sha256', this.tokenSigningKey()).update(`v1.${parts[1]}`).digest();
        const actual = Buffer.from(parts[2], 'base64url');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

        let payload;
        try {
            payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (payload.typ !== expectedType) return null;
        if (payload.cid !== process.env.OAUTH_CLIENT_ID) return null;
        if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
        return payload;
    }

    /**
     * OAuth helper: constant-time string comparison (avoids leaking the secret through response timing)
     */
    safeEqual(a, b) {
        const bufA = Buffer.from(String(a ?? ''));
        const bufB = Buffer.from(String(b ?? ''));
        return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
    }

    /**
     * OAuth helper: drop expired authorization codes and used-refresh-token records
     */
    pruneOAuthState() {
        const now = Date.now();
        for (const [code, data] of this.authCodes) {
            if (now - data.created_at > 60 * 1000) this.authCodes.delete(code);
        }
        for (const [jti, exp] of this.usedRefreshTokens) {
            if (exp * 1000 <= now) this.usedRefreshTokens.delete(jti);
        }
    }

    async runSSE() {
        const app = express();
        const port = process.env.PORT || 3000;

        // Refuse to expose the mailbox on the network without OAuth, unless explicitly allowed
        const oauthConfigured = Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET);
        if (!oauthConfigured && process.env.ALLOW_UNAUTHENTICATED !== 'true') {
            console.error('[Server] Refusing to start: OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are not set.');
            console.error('[Server] Without them, anyone who finds this URL can read and change the mailbox.');
            console.error('[Server] Set both, or set ALLOW_UNAUTHENTICATED=true for local testing only.');
            process.exit(1);
        }

        const accessTokenTtl = Number(process.env.OAUTH_ACCESS_TOKEN_TTL) || 3600;          // 1 hour
        const refreshTokenTtl = Number(process.env.OAUTH_REFRESH_TOKEN_TTL) || 30 * 86400;  // 30 days

        // Log startup configuration
        console.error('[Server] Starting in HTTP mode (Streamable HTTP at /mcp, legacy SSE at /mcp/sse)');
        console.error('[Server] Port:', port);
        console.error('[Server] Node version:', process.version);
        console.error('[Server] Environment:', process.env.NODE_ENV || 'development');
        console.error('[Server] Email configured:', !!process.env.YAHOO_EMAIL);
        console.error('[Server] Password configured:', !!process.env.YAHOO_APP_PASSWORD);

        // Enable CORS for Claude.ai and remote MCP connections
        app.use(cors({
            origin: true,  // Allow all origins (Render's proxy may modify origin headers)
            credentials: true,
            methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
            exposedHeaders: ['Content-Type', 'Mcp-Session-Id', 'WWW-Authenticate'],
            maxAge: 86400  // Cache preflight for 24 hours
        }));

        // Parse request bodies for different content types
        // Skip /mcp/message which needs raw body for SSE
        app.use((req, res, next) => {
            if (req.path === '/mcp/message') {
                return next();
            }

            // OAuth token endpoint needs both JSON and URL-encoded support
            if (req.path === '/oauth/token') {
                // Parse both JSON and URL-encoded bodies
                express.json()(req, res, (err) => {
                    if (err) return next(err);
                    express.urlencoded({ extended: true })(req, res, next);
                });
            } else {
                // All other endpoints just need JSON
                express.json()(req, res, next);
            }
        });

        // Request logging middleware
        app.use((req, res, next) => {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            next();
        });

        // Authentication middleware for MCP endpoints
        const authenticateMCP = (req, res, next) => {
            // Skip auth for health check, OAuth endpoints, and discovery endpoints
            if (req.path === '/health' ||
                req.path === '/' ||
                req.path.startsWith('/.well-known/') ||
                req.path === '/register' ||
                req.path.startsWith('/oauth/')) {
                return next();
            }

            // Only reachable with ALLOW_UNAUTHENTICATED=true (the server refuses to start otherwise)
            if (!oauthConfigured) {
                console.error('[Auth] WARNING: OAuth not configured - server is UNSECURED!');
                return next();
            }

            // Point clients at the protected resource metadata for this endpoint
            const resourcePath = req.path.startsWith('/mcp/') ? '/mcp/sse' : '/mcp';
            res.set('WWW-Authenticate', `Bearer resource_metadata="https://${req.get('host')}/.well-known/oauth-protected-resource${resourcePath}"`);

            // Validate OAuth Bearer token
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.error('[Auth] Missing or invalid Authorization header');
                return res.status(401).json({
                    error: 'unauthorized',
                    error_description: 'Bearer token required'
                });
            }

            const token = authHeader.substring(7); // Remove 'Bearer ' prefix

            // Validate token (signature, client, and expiry)
            if (!this.verifyToken(token, 'access')) {
                console.error('[Auth] Invalid or expired access token');
                return res.status(401).json({
                    error: 'invalid_token',
                    error_description: 'The access token is invalid or has expired'
                });
            }

            console.error('[Auth] OAuth authentication successful');
            next();
        };

        // Apply authentication to all MCP endpoints
        app.use(authenticateMCP);

        // Helper function to generate OAuth metadata
        const getOAuthMetadata = (req) => {
            const baseUrl = `https://${req.get('host')}`;
            return {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp']
            };
        };

        // Helper function to generate protected resource metadata
        const getProtectedResourceMetadata = (req, resourcePath = '') => {
            const baseUrl = `https://${req.get('host')}`;
            return {
                resource: resourcePath ? `${baseUrl}${resourcePath}` : baseUrl,
                authorization_servers: [baseUrl],
                scopes_supported: ['mcp']
            };
        };

        // OpenID Configuration (superset of OAuth authorization server metadata)
        app.get('/.well-known/openid-configuration', (req, res) => {
            console.error('[OAuth] OpenID configuration requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth 2.0 Authorization Server Metadata (RFC 8414)
        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            console.error('[OAuth] Authorization server metadata requested');
            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server/mcp', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp requested');
            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp/sse requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth Protected Resource Metadata
        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            console.error('[OAuth] Protected resource metadata requested');
            res.json(getProtectedResourceMetadata(req));
        });

        app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp requested');
            res.json(getProtectedResourceMetadata(req, '/mcp'));
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            res.json(getProtectedResourceMetadata(req, '/mcp/sse'));
        });

        // OAuth Authorization Endpoint (Authorization Code Flow)
        app.get('/oauth/authorize', (req, res) => {
            console.error('[OAuth] Authorization request received');
            console.error('[OAuth] Query params:', JSON.stringify(req.query).substring(0, 200));

            const clientId = process.env.OAUTH_CLIENT_ID;
            const {
                response_type,
                client_id,
                redirect_uri,
                state,
                code_challenge,
                code_challenge_method,
                scope
            } = req.query;

            // Validate client_id
            if (!clientId || client_id !== clientId) {
                console.error('[OAuth] Invalid client_id in authorize request');
                return res.status(400).send('Invalid client_id');
            }

            // Validate response_type
            if (response_type !== 'code') {
                console.error('[OAuth] Unsupported response_type:', response_type);
                return res.status(400).send('Unsupported response_type');
            }

            // Validate redirect_uri by exact hostname (a substring check would accept e.g. https://evil.example/?claude.ai).
            // OAUTH_REDIRECT_HOSTS adds other MCP clients, e.g. "chatgpt.com"; subdomains of a listed host are allowed.
            const allowedHosts = (process.env.OAUTH_REDIRECT_HOSTS || 'claude.ai,claude.com')
                .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
            let redirectHost = null;
            let redirectProtocol = null;
            try {
                const parsed = new URL(redirect_uri);
                redirectHost = parsed.hostname.toLowerCase();
                redirectProtocol = parsed.protocol;
            } catch {
                // invalid URL; rejected below
            }
            const isLocal = redirectHost === 'localhost' || redirectHost === '127.0.0.1';
            const isAllowed = redirectHost && (
                (isLocal && (redirectProtocol === 'http:' || redirectProtocol === 'https:')) ||
                (redirectProtocol === 'https:' && allowedHosts.some(h => redirectHost === h || redirectHost.endsWith(`.${h}`)))
            );
            if (!isAllowed) {
                console.error('[OAuth] Invalid redirect_uri:', redirect_uri);
                return res.status(400).send('Invalid redirect_uri');
            }

            // PKCE: only S256 is supported
            if (code_challenge && code_challenge_method && code_challenge_method !== 'S256') {
                console.error('[OAuth] Unsupported code_challenge_method:', code_challenge_method);
                return res.status(400).send('Unsupported code_challenge_method (use S256)');
            }

            // Generate a random authorization code (valid for 60 seconds, usable once)
            this.pruneOAuthState();
            const authCode = crypto.randomBytes(32).toString('base64url');
            this.authCodes.set(authCode, {
                client_id,
                redirect_uri,
                code_challenge,
                code_challenge_method,
                scope,
                created_at: Date.now()
            });

            console.error('[OAuth] Authorization code generated, redirecting to:', redirect_uri);

            // Redirect back to Claude with authorization code
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.append('code', authCode);
            if (state) redirectUrl.searchParams.append('state', state);

            res.redirect(redirectUrl.toString());
        });

        // OAuth Token Endpoint (supports both Authorization Code and Client Credentials flows)
        app.post('/oauth/token', async (req, res) => {
            console.error('[OAuth] Token request - grant type:', req.body?.grant_type || 'unknown');

            const clientId = process.env.OAUTH_CLIENT_ID;
            const clientSecret = process.env.OAUTH_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
                console.error('[OAuth] Server misconfigured - OAuth credentials not set');
                return res.status(500).json({
                    error: 'server_error',
                    error_description: 'OAuth not configured on server'
                });
            }

            // Extract credentials from Authorization header (Basic Auth) or request body
            let reqClientId, reqClientSecret;
            const authHeader = req.headers.authorization;

            if (authHeader && authHeader.startsWith('Basic ')) {
                // Split on the first ':' only; the secret itself may contain ':'
                const credentials = Buffer.from(authHeader.substring(6), 'base64').toString();
                const sep = credentials.indexOf(':');
                reqClientId = sep === -1 ? credentials : credentials.slice(0, sep);
                reqClientSecret = sep === -1 ? '' : credentials.slice(sep + 1);
            } else {
                reqClientId = req.body?.client_id;
                reqClientSecret = req.body?.client_secret;
            }

            // Validate credentials
            if (!this.safeEqual(reqClientId, clientId) || !this.safeEqual(reqClientSecret, clientSecret)) {
                console.error('[OAuth] Authentication failed - invalid client credentials');
                return res.status(401).json({
                    error: 'invalid_client',
                    error_description: 'Invalid client credentials'
                });
            }

            const grantType = req.body?.grant_type;

            const tokenResponse = (scope, withRefresh) => {
                const body = {
                    access_token: this.issueToken('access', clientId, accessTokenTtl, scope),
                    token_type: 'Bearer',
                    expires_in: accessTokenTtl,
                    scope
                };
                if (withRefresh) body.refresh_token = this.issueToken('refresh', clientId, refreshTokenTtl, scope);
                res.set('Cache-Control', 'no-store');
                return res.json(body);
            };
            const invalidGrant = (description) => res.status(400).json({ error: 'invalid_grant', error_description: description });

            this.pruneOAuthState();

            // Handle Authorization Code Grant (with PKCE)
            if (grantType === 'authorization_code') {
                const { code, redirect_uri, code_verifier } = req.body || {};
                console.error('[OAuth] Authorization code grant - validating code');

                const authData = code ? this.authCodes.get(code) : undefined;
                if (!authData) {
                    console.error('[OAuth] Invalid or expired authorization code');
                    return invalidGrant('Invalid or expired authorization code');
                }
                this.authCodes.delete(code);  // one-time use, even if the checks below fail

                if (Date.now() - authData.created_at > 60 * 1000) {
                    return invalidGrant('Authorization code expired');
                }
                if (redirect_uri !== undefined && redirect_uri !== authData.redirect_uri) {
                    return invalidGrant('redirect_uri does not match the authorization request');
                }
                if (authData.code_challenge) {
                    if (typeof code_verifier !== 'string' || code_verifier.length === 0) {
                        return invalidGrant('code_verifier is required');
                    }
                    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
                    if (!this.safeEqual(hash, authData.code_challenge)) {
                        console.error('[OAuth] PKCE validation failed');
                        return invalidGrant('PKCE validation failed');
                    }
                }

                console.error('[OAuth] Access and refresh tokens issued from authorization code');
                return tokenResponse(authData.scope || 'mcp', true);
            }

            // Handle Refresh Token Grant (each refresh token works once and is replaced)
            if (grantType === 'refresh_token') {
                const payload = this.verifyToken(req.body?.refresh_token, 'refresh');
                if (!payload) {
                    return invalidGrant('Invalid or expired refresh token');
                }
                if (this.usedRefreshTokens.has(payload.jti)) {
                    console.error('[OAuth] Refresh token reuse detected');
                    return invalidGrant('Refresh token has already been used');
                }
                this.usedRefreshTokens.set(payload.jti, payload.exp);

                console.error('[OAuth] Tokens refreshed');
                return tokenResponse(payload.scope || 'mcp', true);
            }

            // Handle Client Credentials Grant (no refresh token; the client can simply request a new token)
            if (grantType === 'client_credentials') {
                console.error('[OAuth] Access token issued via client credentials');
                return tokenResponse('mcp', false);
            }

            // Unsupported grant type
            console.error('[OAuth] Unsupported grant type:', grantType);
            res.status(400).json({
                error: 'unsupported_grant_type',
                error_description: 'Supported grant types: authorization_code, refresh_token, client_credentials'
            });
        });

        // Dynamic client registration endpoint (not supported)
        app.post('/register', (req, res) => {
            console.error('[OAuth] Client registration attempted - not supported');
            res.status(404).json({
                error: 'unsupported_operation',
                error_description: 'Dynamic client registration is not supported. Use static OAuth credentials.'
            });
        });

        // Health check endpoint (enhanced with environment info)
        app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                service: 'yahoo-mail-mcp',
                version: '3.1.0',
                timestamp: new Date().toISOString(),
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    emailConfigured: !!process.env.YAHOO_EMAIL,
                    passwordConfigured: !!process.env.YAHOO_APP_PASSWORD,
                    transportMode: process.env.TRANSPORT_MODE || 'stdio'
                }
            });
        });

        // Streamable HTTP endpoint (current MCP transport), stateless: each POST gets its own
        // MCP server object and transport, so nothing is lost if the service restarts or sleeps
        app.post('/mcp', async (req, res) => {
            const server = this.createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,  // stateless: no Mcp-Session-Id
                enableJsonResponse: true        // reply with plain JSON instead of an SSE stream
            });
            res.on('close', () => {
                transport.close();
                server.close();
            });

            try {
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('[HTTP] Error handling MCP request:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal server error' },
                        id: null
                    });
                }
            }
        });

        // Stateless mode has no server-initiated stream (GET) or session to end (DELETE)
        const methodNotAllowed = (req, res) => {
            res.status(405).set('Allow', 'POST').json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Method not allowed. This server is stateless; send requests with POST.' },
                id: null
            });
        };
        app.get('/mcp', methodNotAllowed);
        app.delete('/mcp', methodNotAllowed);

        // Legacy SSE endpoint for MCP (deprecated transport, kept for existing clients)
        app.get('/mcp/sse', async (req, res) => {
            try {
                console.error('[SSE] New connection established from:', req.ip);
                console.error('[SSE] Origin:', req.headers.origin);
                console.error('[SSE] User-Agent:', req.headers['user-agent']);

                const transport = new SSEServerTransport('/mcp/message', res);

                // Get session ID from transport
                const sessionId = transport.sessionId;
                console.error('[SSE] Session ID:', sessionId);

                // Store the transport for message routing
                this.transports.set(sessionId, transport);

                // Clean up on disconnect
                transport.onclose = () => {
                    console.error('[SSE] Connection closed, cleaning up session:', sessionId);
                    this.transports.delete(sessionId);
                };

                await this.server.connect(transport);
                console.error('[SSE] MCP server connected to transport');
            } catch (error) {
                console.error('[SSE] Error connecting transport:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // Message endpoint for SSE
        app.post('/mcp/message', async (req, res) => {
            console.error('[SSE] Received message on /mcp/message');
            console.error('[SSE] Active transports:', this.transports.size);

            // Extract session ID from query or headers (body not parsed yet)
            const sessionId = req.query?.sessionId || req.headers['x-session-id'];
            console.error('[SSE] Session ID from request:', sessionId);

            if (sessionId && this.transports.has(sessionId)) {
                const transport = this.transports.get(sessionId);
                console.error('[SSE] Routing message to transport:', sessionId);
                // Let the transport handle the message
                transport.handlePostMessage(req, res);
            } else {
                // If no session ID or transport not found, try the first available transport
                // (for backwards compatibility with single-connection scenario)
                const firstTransport = Array.from(this.transports.values())[0];
                if (firstTransport) {
                    console.error('[SSE] No session ID, using first available transport');
                    firstTransport.handlePostMessage(req, res);
                } else {
                    console.error('[SSE] No active transport found');
                    res.status(404).json({ error: 'No active SSE connection found' });
                }
            }
        });

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('[Express] Error:', err);
            res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        });

        // Root endpoint
        app.get('/', (req, res) => {
            res.json({
                name: 'Yahoo Mail MCP Server',
                version: '3.1.0',
                description: 'MCP server for Yahoo Mail access via IMAP',
                endpoints: {
                    health: '/health',
                    mcp: '/mcp',
                    sse: '/mcp/sse',
                    message: '/mcp/message'
                },
                tools: [
                    'list_emails',
                    'read_email',
                    'search_emails',
                    'delete_emails',
                    'archive_emails',
                    'mark_as_read',
                    'mark_as_unread',
                    'flag_emails',
                    'unflag_emails',
                    'move_emails',
                    'list_folders',
                    'download_attachments',
                    'create_draft',
                    'create_reply_draft',
                    'update_draft'
                ]
            });
        });

        app.listen(port, () => {
            console.error(`Yahoo Mail MCP server running on port ${port}`);
            console.error(`Streamable HTTP endpoint: http://localhost:${port}/mcp`);
            console.error(`Legacy SSE endpoint: http://localhost:${port}/mcp/sse`);
            console.error(`Health check: http://localhost:${port}/health`);
        });
    }
}

export { YahooMailMCPServer };

// Start the server when run directly (not when imported, e.g. by offline tests)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    const server = new YahooMailMCPServer();
    server.run().catch(console.error);
}