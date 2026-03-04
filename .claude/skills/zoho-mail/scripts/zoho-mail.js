#!/usr/bin/env node
/**
 * Zoho Mail API Client
 * Handles all Zoho Mail API operations via OAuth2
 */

import axios from 'axios';
import { readFileSync, existsSync, createWriteStream } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Data center configurations
const DATA_CENTERS = {
  com: { accounts: 'accounts.zoho.com', api: 'mail.zoho.com' },
  eu: { accounts: 'accounts.zoho.eu', api: 'mail.zoho.eu' },
  in: { accounts: 'accounts.zoho.in', api: 'mail.zoho.in' },
  cn: { accounts: 'accounts.zoho.com.cn', api: 'mail.zoho.com.cn' },
  'com.au': { accounts: 'accounts.zoho.com.au', api: 'mail.zoho.com.au' }
};

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

// Get data center config
function getDataCenter(env) {
  const dc = env.ZOHO_DATA_CENTER || 'com';
  return DATA_CENTERS[dc] || DATA_CENTERS.com;
}

// Get access token from refresh token
async function getAccessToken(env) {
  const dc = getDataCenter(env);
  const tokenUrl = `https://${dc.accounts}/oauth/v2/token`;

  try {
    // Build form data (application/x-www-form-urlencoded)
    const params = new URLSearchParams();
    params.append('refresh_token', env.ZOHO_REFRESH_TOKEN);
    params.append('grant_type', 'refresh_token');
    params.append('client_id', env.ZOHO_CLIENT_ID);
    params.append('client_secret', env.ZOHO_CLIENT_SECRET);

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return response.data.access_token;
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data?.error || error.message);
    throw new Error('Failed to refresh access token. Run auth.js to re-authenticate.');
  }
}

// Get API client
async function getApiClient() {
  const env = loadEnv();

  if (!env.ZOHO_REFRESH_TOKEN) {
    console.error('Error: ZOHO_REFRESH_TOKEN not set in .env');
    console.error('Run: node ~/.claude/skills/zoho-mail/scripts/auth.js');
    process.exit(1);
  }

  const accessToken = await getAccessToken(env);
  const dc = getDataCenter(env);

  const client = axios.create({
    baseURL: `https://${dc.api}/api`,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  return { client, env };
}

// List folders
async function listFolders() {
  const { client, env } = await getApiClient();

  try {
    const response = await client.get(`/accounts/${env.ZOHO_ACCOUNT_ID}/folders`);
    const folders = response.data.data || [];

    console.log('\n📁 Folders\n');

    folders.forEach((folder, index) => {
      console.log(`${index + 1}. ${folder.folderName} (${folder.folderCount || 0} messages)`);
      console.log(`   ID: ${folder.folderId}`);
      if (folder.unreadCount > 0) {
        console.log(`   Unread: ${folder.unreadCount}`);
      }
      console.log('');
    });

    return folders;
  } catch (error) {
    console.error('Error listing folders:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Create folder
async function createFolder(folderName, parentFolderId = null) {
  const { client, env } = await getApiClient();

  try {
    const payload = {
      folderName,
      parentFolderId: parentFolderId || '0'
    };

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/folders`, payload);

    console.log(`✅ Folder created: ${folderName}`);
    console.log(`   ID: ${response.data.data?.folderId}`);

    return response.data;
  } catch (error) {
    console.error('Error creating folder:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Delete folder
async function deleteFolder(folderId) {
  const { client, env } = await getApiClient();

  try {
    await client.delete(`/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}`);

    console.log(`✅ Folder deleted: ${folderId}`);
  } catch (error) {
    console.error('Error deleting folder:', error.response?.data?.message || error.message);
    throw error;
  }
}

// List emails in folder
async function listEmails(folderId = null, maxResults = 10, query = null) {
  const { client, env } = await getApiClient();

  try {
    let url;
    let params = { limit: maxResults };

    if (query) {
      url = `/accounts/${env.ZOHO_ACCOUNT_ID}/messages/search`;
      params.searchType = 'query';
      params.searchValue = query;
    } else {
      const fid = folderId || 'inbox';
      url = `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${fid}/messages`;
    }

    const response = await client.get(url, { params });
    const emails = response.data.data || [];

    if (emails.length === 0) {
      console.log('No emails found.');
      return [];
    }

    console.log(`\n📧 ${emails.length} emails\n`);

    emails.forEach((email, index) => {
      const isUnread = email.isUnread ? '[UNREAD] ' : '';
      const subject = email.subject || '(No subject)';
      const from = email.fromAddress || 'Unknown';
      const snippet = email.summary ? email.summary.substring(0, 100) + (email.summary.length > 100 ? '...' : '') : '';

      console.log(`${index + 1}. ${isUnread}From: ${from}`);
      console.log(`   Subject: ${subject}`);
      if (snippet) console.log(`   Preview: ${snippet}`);
      console.log(`   ID: ${email.messageId}`);
      if (email.folderId) console.log(`   Folder: ${email.folderId}`);
      console.log('');
    });

    return emails;
  } catch (error) {
    console.error('Error listing emails:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Read specific email
async function readEmail(messageId, folderId) {
  const { client, env } = await getApiClient();

  try {
    // Get email content
    const contentResponse = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/content`
    );

    // Get email details
    const detailsResponse = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/details`
    );

    const email = contentResponse.data.data;
    const details = detailsResponse.data.data;

    console.log('\n📧 Email Details\n');
    console.log(`From: ${email.fromAddress || 'Unknown'}`);
    console.log(`To: ${email.toAddress || 'Unknown'}`);
    if (email.ccAddress) console.log(`Cc: ${email.ccAddress}`);
    console.log(`Subject: ${email.subject || '(No subject)'}`);
    console.log(`Date: ${email.receivedTime || 'Unknown'}`);
    console.log(`ID: ${messageId}`);
    console.log(`Folder: ${folderId}`);
    if (details.attachmentCount > 0) {
      console.log(`Attachments: ${details.attachmentCount}`);
    }
    console.log('---');
    console.log(email.content || '(No content)');
    console.log('');

    return { email, details };
  } catch (error) {
    console.error('Error reading email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Send email
async function sendEmail(to, subject, body, options = {}) {
  const { client, env } = await getApiClient();

  try {
    const payload = {
      fromAddress: env.ZOHO_FROM_EMAIL,
      toAddress: to,
      subject: subject,
      content: body,
      mailFormat: options.html ? 'html' : 'plaintext'
    };

    if (options.cc) payload.ccAddress = options.cc;
    if (options.bcc) payload.bccAddress = options.bcc;
    if (options.replyTo) payload.replyTo = options.replyTo;

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, payload);

    console.log(`✅ Email sent to: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Message ID: ${response.data.data?.messageId || response.data.data?.sentTime}`);

    return response.data;
  } catch (error) {
    console.error('Error sending email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Save draft
async function saveDraft(to, subject, body, options = {}) {
  const { client, env } = await getApiClient();

  try {
    const payload = {
      fromAddress: env.ZOHO_FROM_EMAIL,
      toAddress: to,
      subject: subject,
      content: body,
      mailFormat: options.html ? 'html' : 'plaintext',
      mode: 'drafts'
    };

    if (options.cc) payload.ccAddress = options.cc;
    if (options.bcc) payload.bccAddress = options.bcc;

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, payload);

    console.log(`✅ Draft saved`);
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Draft ID: ${response.data.data?.messageId}`);

    return response.data;
  } catch (error) {
    console.error('Error saving draft:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Reply to email
async function replyToEmail(messageId, folderId, body, replyAll = false) {
  const { client, env } = await getApiClient();

  try {
    // First get the original email details
    const originalResponse = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/content`
    );
    const original = originalResponse.data.data;

    const payload = {
      fromAddress: env.ZOHO_FROM_EMAIL,
      toAddress: replyAll ? original.toAddress : original.fromAddress,
      subject: original.subject?.startsWith('Re:') ? original.subject : `Re: ${original.subject}`,
      content: body,
      inReplyTo: messageId,
      mailFormat: 'plaintext'
    };

    if (replyAll && original.ccAddress) {
      payload.ccAddress = original.ccAddress;
    }

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, payload);

    console.log(`✅ Reply sent to: ${payload.toAddress}`);
    console.log(`   Subject: ${payload.subject}`);
    console.log(`   Message ID: ${response.data.data?.messageId}`);

    return response.data;
  } catch (error) {
    console.error('Error replying to email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Forward email
async function forwardEmail(messageId, folderId, toAddress, additionalText = '') {
  const { client, env } = await getApiClient();

  try {
    const originalResponse = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/content`
    );
    const original = originalResponse.data.data;

    const payload = {
      fromAddress: env.ZOHO_FROM_EMAIL,
      toAddress: toAddress,
      subject: original.subject?.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`,
      content: additionalText + '\n\n--- Forwarded Message ---\n\n' + (original.content || ''),
      mailFormat: 'plaintext'
    };

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, payload);

    console.log(`✅ Email forwarded to: ${toAddress}`);
    console.log(`   Subject: ${payload.subject}`);
    console.log(`   Message ID: ${response.data.data?.messageId}`);

    return response.data;
  } catch (error) {
    console.error('Error forwarding email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Update email (mark read/unread, move, etc.)
async function updateEmail(messageIds, action, value = null) {
  const { client, env } = await getApiClient();

  try {
    const ids = Array.isArray(messageIds) ? messageIds.join(',') : messageIds;

    const payload = {
      messageId: ids
    };

    switch (action) {
      case 'read':
        payload.isRead = true;
        break;
      case 'unread':
        payload.isRead = false;
        break;
      case 'move':
        if (!value) throw new Error('Folder ID required for move action');
        payload.folderId = value;
        break;
      case 'spam':
        payload.isSpam = true;
        break;
      case 'notspam':
        payload.isSpam = false;
        break;
      case 'flag':
        payload.flag = value || 'flagged';
        break;
      case 'unflag':
        payload.flag = 'unflagged';
        break;
      case 'tag':
        if (!value) throw new Error('Tag name required');
        payload.tagNames = value;
        break;
      case 'untag':
        if (!value) throw new Error('Tag name required');
        payload.removeTags = value;
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const response = await client.put(`/accounts/${env.ZOHO_ACCOUNT_ID}/updatemessage`, payload);

    console.log(`✅ Email(s) updated: ${action}`);
    if (value) console.log(`   Value: ${value}`);

    return response.data;
  } catch (error) {
    console.error('Error updating email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Delete email
async function deleteEmail(messageId, folderId) {
  const { client, env } = await getApiClient();

  try {
    await client.delete(`/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}`);

    console.log(`✅ Email deleted: ${messageId}`);
  } catch (error) {
    console.error('Error deleting email:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Get attachment info
async function getAttachmentInfo(messageId, folderId) {
  const { client, env } = await getApiClient();

  try {
    const response = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/attachmentinfo`
    );

    const attachments = response.data.data?.attachments || [];

    console.log(`\n📎 Attachments (${attachments.length})\n`);

    attachments.forEach((att, index) => {
      console.log(`${index + 1}. ${att.fileName}`);
      console.log(`   Size: ${(att.fileSize / 1024).toFixed(2)} KB`);
      console.log(`   Type: ${att.contentType}`);
      console.log(`   ID: ${att.attachmentId}`);
      console.log('');
    });

    return attachments;
  } catch (error) {
    console.error('Error getting attachment info:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Download attachment
async function downloadAttachment(messageId, folderId, attachmentId, outputPath) {
  const { client, env } = await getApiClient();

  try {
    const response = await client.get(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`,
      { responseType: 'stream' }
    );

    await pipeline(response.data, createWriteStream(outputPath));

    console.log(`✅ Attachment downloaded: ${outputPath}`);
  } catch (error) {
    console.error('Error downloading attachment:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Upload attachment
async function uploadAttachment(filePath) {
  const { client, env } = await getApiClient();
  const FormData = (await import('form-data')).default;
  const form = new FormData();

  try {
    form.append('file', readFileSync(filePath), { filename: filePath.split('/').pop() });

    const response = await client.post(
      `/accounts/${env.ZOHO_ACCOUNT_ID}/messages/attachments`,
      form,
      { headers: form.getHeaders() }
    );

    console.log(`✅ Attachment uploaded: ${filePath}`);
    console.log(`   Attachment ID: ${response.data.data?.attachmentId}`);

    return response.data;
  } catch (error) {
    console.error('Error uploading attachment:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Send email with attachment
async function sendEmailWithAttachment(to, subject, body, attachmentIds, options = {}) {
  const { client, env } = await getApiClient();

  try {
    const payload = {
      fromAddress: env.ZOHO_FROM_EMAIL,
      toAddress: to,
      subject: subject,
      content: body,
      mailFormat: options.html ? 'html' : 'plaintext',
      attach: Array.isArray(attachmentIds) ? attachmentIds.join(',') : attachmentIds
    };

    if (options.cc) payload.ccAddress = options.cc;
    if (options.bcc) payload.bccAddress = options.bcc;

    const response = await client.post(`/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, payload);

    console.log(`✅ Email sent with attachment(s) to: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Message ID: ${response.data.data?.messageId}`);

    return response.data;
  } catch (error) {
    console.error('Error sending email with attachment:', error.response?.data?.message || error.message);
    throw error;
  }
}

// Search emails
async function searchEmails(query, maxResults = 10) {
  return listEmails(null, maxResults, query);
}

// CLI
const command = process.argv[2];

async function main() {
  switch (command) {
    case 'folders':
      await listFolders();
      break;
    case 'folder-create':
      if (!process.argv[3]) {
        console.error('Usage: zoho-mail.js folder-create <folderName> [parentFolderId]');
        process.exit(1);
      }
      await createFolder(process.argv[3], process.argv[4]);
      break;
    case 'folder-delete':
      if (!process.argv[3]) {
        console.error('Usage: zoho-mail.js folder-delete <folderId>');
        process.exit(1);
      }
      await deleteFolder(process.argv[3]);
      break;
    case 'inbox':
      await listEmails(process.argv[3] || 'inbox', parseInt(process.argv[4]) || 10);
      break;
    case 'read':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js read <messageId> <folderId>');
        process.exit(1);
      }
      await readEmail(process.argv[3], process.argv[4]);
      break;
    case 'send':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js send <to> <subject> [body] [--cc=cc@example.com] [--bcc=bcc@example.com]');
        process.exit(1);
      }
      const body = (process.argv[5] || '').replace(/\\n/g, '\n');
      const options = {};
      process.argv.slice(6).forEach(arg => {
        if (arg.startsWith('--cc=')) options.cc = arg.split('=')[1];
        if (arg.startsWith('--bcc=')) options.bcc = arg.split('=')[1];
        if (arg === '--html') options.html = true;
      });
      await sendEmail(process.argv[3], process.argv[4], body, options);
      break;
    case 'draft':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js draft <to> <subject> [body]');
        process.exit(1);
      }
      await saveDraft(process.argv[3], process.argv[4], (process.argv[5] || '').replace(/\\n/g, '\n'));
      break;
    case 'reply':
      if (!process.argv[3] || !process.argv[4] || !process.argv[5]) {
        console.error('Usage: zoho-mail.js reply <messageId> <folderId> <body> [--all]');
        process.exit(1);
      }
      await replyToEmail(process.argv[3], process.argv[4], process.argv[5].replace(/\\n/g, '\n'), process.argv.includes('--all'));
      break;
    case 'forward':
      if (!process.argv[3] || !process.argv[4] || !process.argv[5]) {
        console.error('Usage: zoho-mail.js forward <messageId> <folderId> <to> [additionalText]');
        process.exit(1);
      }
      await forwardEmail(process.argv[3], process.argv[4], process.argv[5], (process.argv[6] || '').replace(/\\n/g, '\n'));
      break;
    case 'update':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js update <messageId> <action> [value]');
        console.error('Actions: read, unread, move, spam, notspam, flag, unflag, tag, untag');
        process.exit(1);
      }
      await updateEmail(process.argv[3], process.argv[4], process.argv[5]);
      break;
    case 'delete':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js delete <messageId> <folderId>');
        process.exit(1);
      }
      await deleteEmail(process.argv[3], process.argv[4]);
      break;
    case 'search':
      if (!process.argv[3]) {
        console.error('Usage: zoho-mail.js search <query> [maxResults]');
        process.exit(1);
      }
      await searchEmails(process.argv[3], parseInt(process.argv[4]) || 10);
      break;
    case 'attachments':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: zoho-mail.js attachments <messageId> <folderId>');
        process.exit(1);
      }
      await getAttachmentInfo(process.argv[3], process.argv[4]);
      break;
    case 'download':
      if (!process.argv[3] || !process.argv[4] || !process.argv[5] || !process.argv[6]) {
        console.error('Usage: zoho-mail.js download <messageId> <folderId> <attachmentId> <outputPath>');
        process.exit(1);
      }
      await downloadAttachment(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
      break;
    case 'upload':
      if (!process.argv[3]) {
        console.error('Usage: zoho-mail.js upload <filePath>');
        process.exit(1);
      }
      await uploadAttachment(process.argv[3]);
      break;
    case 'send-attachment':
      if (!process.argv[3] || !process.argv[4] || !process.argv[5]) {
        console.error('Usage: zoho-mail.js send-attachment <to> <subject> <attachmentIds> [body]');
        process.exit(1);
      }
      await sendEmailWithAttachment(process.argv[3], process.argv[4], process.argv[6] || '', process.argv[5]);
      break;
    default:
      console.log(`
Zoho Mail Skill CLI

Usage:
  zoho-mail.js folders                          List all folders
  zoho-mail.js folder-create <name> [parent]    Create folder
  zoho-mail.js folder-delete <folderId>         Delete folder
  zoho-mail.js inbox [folderId] [count]         List emails in folder
  zoho-mail.js read <msgId> <folderId>          Read specific email
  zoho-mail.js send <to> <subject> [body]       Send email
  zoho-mail.js draft <to> <subject> [body]      Save draft
  zoho-mail.js reply <msgId> <folderId> <body>  Reply to email
  zoho-mail.js forward <msgId> <folderId> <to>  Forward email
  zoho-mail.js update <msgId> <action> [value]  Update email (read/unread/move/etc)
  zoho-mail.js delete <msgId> <folderId>        Delete email
  zoho-mail.js search <query> [count]           Search emails
  zoho-mail.js attachments <msgId> <folderId>   List attachments
  zoho-mail.js download <msgId> <folderId> <attId> <path>  Download attachment
  zoho-mail.js upload <filePath>                Upload attachment
  zoho-mail.js send-attachment <to> <subject> <attIds> [body]  Send with attachments

Examples:
  zoho-mail.js inbox inbox 5
  zoho-mail.js search "from:boss@company.com" 10
  zoho-mail.js send "friend@example.com" "Hello" "How are you?"
  zoho-mail.js reply 123456 inbox "Thanks for the info"
  zoho-mail.js update 123456 read
  zoho-mail.js update 123456 move 987654
`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
