#!/usr/bin/env node
/**
 * Gmail Skill Implementation
 * Handles Gmail API operations via OAuth2
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load environment variables from project .env
function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.error('Error: .env file not found');
    process.exit(1);
  }

  const envContent = readFileSync(envPath, 'utf-8');
  const env = {};

  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }

  return env;
}

// Get Gmail client
async function getGmailClient() {
  const env = loadEnv();

  if (!env.GMAIL_REFRESH_TOKEN) {
    console.error('Error: GMAIL_REFRESH_TOKEN not set in .env');
    console.error('Run: node ~/.claude/skills/gmail/scripts/auth.js');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    'http://localhost:3000/oauth2callback'
  );

  oauth2Client.setCredentials({
    refresh_token: env.GMAIL_REFRESH_TOKEN
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// List recent emails
async function listInbox(maxResults = 10, query = '') {
  const gmail = await getGmailClient();

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: query
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    console.log('No emails found.');
    return;
  }

  console.log(`\n📧 ${res.data.resultSizeEstimate} emails\n`);

  for (let i = 0; i < res.data.messages.length; i++) {
    const msg = res.data.messages[i];
    const details = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id
    });

    const headers = details.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
    const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
    const isUnread = details.data.labelIds?.includes('UNREAD') ? '[UNREAD] ' : '';

    // Get snippet from body if available
    let snippet = details.data.snippet || '';
    if (snippet.length > 100) snippet = snippet.substring(0, 100) + '...';

    console.log(`${i + 1}. ${isUnread}From: ${from}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Preview: ${snippet}`);
    console.log(`   ID: ${msg.id}`);
    console.log('');
  }
}

// Read specific email
async function readEmail(messageId) {
  const gmail = await getGmailClient();

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId
  });

  const headers = res.data.payload.headers;
  const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
  const to = headers.find(h => h.name === 'To')?.value || 'Unknown';
  const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
  const date = headers.find(h => h.name === 'Date')?.value || 'Unknown';

  console.log(`\n📧 Email Details\n`);
  console.log(`From: ${from}`);
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Date: ${date}`);
  console.log(`ID: ${messageId}`);
  console.log('---');

  // Extract body
  let body = '';
  if (res.data.payload.parts) {
    const textPart = res.data.payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart && textPart.body.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    }
  } else if (res.data.payload.body && res.data.payload.body.data) {
    body = Buffer.from(res.data.payload.body.data, 'base64').toString('utf-8');
  }

  console.log(body || '(No text content)');
  console.log('');
}

// Send email
async function sendEmail(to, subject, body) {
  const gmail = await getGmailClient();
  const env = loadEnv();

  const message = [
    `From: ${env.GMAIL_USER_EMAIL}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(body).toString('base64')
  ].join('\r\n');

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage
    }
  });

  console.log(`✅ Email sent to: ${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Message ID: ${res.data.id}`);
}

// Reply to email
async function replyToEmail(messageId, replyBody) {
  const gmail = await getGmailClient();

  // Get original message
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId
  });

  const headers = original.data.payload.headers;
  const from = headers.find(h => h.name === 'From')?.value;
  const subject = headers.find(h => h.name === 'Subject')?.value;
  const messageIdHeader = headers.find(h => h.name === 'Message-ID')?.value;

  const env = loadEnv();

  const replySubject = subject?.startsWith('Re:') ? subject : `Re: ${subject}`;

  const message = [
    `From: ${env.GMAIL_USER_EMAIL}`,
    `To: ${from}`,
    `Subject: =?utf-8?B?${Buffer.from(replySubject).toString('base64')}?=`,
    `In-Reply-To: ${messageIdHeader}`,
    `References: ${messageIdHeader}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(replyBody).toString('base64')
  ].join('\r\n');

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: original.data.threadId
    }
  });

  console.log(`✅ Reply sent to: ${from}`);
  console.log(`   Subject: ${replySubject}`);
  console.log(`   Message ID: ${res.data.id}`);
}

// CLI
const command = process.argv[2];

async function main() {
  switch (command) {
    case 'inbox':
      await listInbox(parseInt(process.argv[3]) || 10, process.argv[4] || '');
      break;
    case 'read':
      if (!process.argv[3]) {
        console.error('Usage: gmail.js read <messageId>');
        process.exit(1);
      }
      await readEmail(process.argv[3]);
      break;
    case 'send':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: gmail.js send <to> <subject> [body]');
        process.exit(1);
      }
      const body = (process.argv[5] || '').replace(/\\n/g, '\n');
      await sendEmail(process.argv[3], process.argv[4], body);
      break;
    case 'reply':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: gmail.js reply <messageId> <body>');
        process.exit(1);
      }
      const replyBody = (process.argv[4] || '').replace(/\\n/g, '\n');
      await replyToEmail(process.argv[3], replyBody);
      break;
    case 'search':
      await listInbox(10, process.argv[3] || '');
      break;
    default:
      console.log(`
Gmail Skill CLI

Usage:
  gmail.js inbox [count] [query]    List recent emails
  gmail.js read <messageId>         Read specific email
  gmail.js send <to> <subject> [body] Send email
  gmail.js reply <messageId> <body> Reply to email
  gmail.js search <query>           Search emails

Examples:
  gmail.js inbox 5
  gmail.js search "from:boss@company.com is:unread"
  gmail.js send "friend@example.com" "Hello" "How are you?"
`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
