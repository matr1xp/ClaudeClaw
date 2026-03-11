import axios from 'axios';
import { readFileSync } from 'fs';

// Load env from project
const envContent = readFileSync('/Users/marlon/workspace/Projects/AI/ClaudeClaw/.env', 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

async function getToken() {
  const params = new URLSearchParams();
  params.append('refresh_token', env.ZOHO_REFRESH_TOKEN);
  params.append('grant_type', 'refresh_token');
  params.append('client_id', env.ZOHO_CLIENT_ID);
  params.append('client_secret', env.ZOHO_CLIENT_SECRET);
  
  const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data.access_token;
}

async function main() {
  const token = await getToken();
  
  const client = axios.create({
    baseURL: 'https://mail.zoho.com/api',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
  });
  
  // Get folder info first
  const foldersRes = await client.get('/accounts/' + env.ZOHO_ACCOUNT_ID + '/folders');
  const inbox = foldersRes.data.data.find(f => f.folderType === 'Inbox');
  const unreadCount = inbox?.folderCount - (inbox?.readCount || 0) || 0;
  
  // Get messages - use view endpoint with folderId param
  const response = await client.get('/accounts/' + env.ZOHO_ACCOUNT_ID + '/messages/view', {
    params: { folderId: inbox.folderId, limit: 10, sortorder: 'true' }
  });
  
  const emails = response.data.data || [];
  
  console.log('\n📧 Zoho Mail Inbox\n');
  console.log(unreadCount + ' unread | ' + (inbox?.folderCount || 0) + ' total\n');
  
  emails.forEach((email, i) => {
    const isUnread = email.status2 === '0' ? '[UNREAD] ' : '';
    const subject = email.subject || '(No subject)';
    const fromRaw = email.fromAddress || 'Unknown';
    const from = fromRaw.replace(/<.*?>/, '').replace(/&quot;/g, '').trim() || 'Unknown';
    const snippet = email.summary ? email.summary.substring(0, 80) + (email.summary.length > 80 ? '...' : '') : '';
    const date = new Date(parseInt(email.sentDateInGMT)).toLocaleDateString();
    
    console.log((i + 1) + '. ' + isUnread + 'From: ' + from);
    console.log('   Subject: ' + subject);
    if (snippet) console.log('   Preview: ' + snippet);
    console.log('   Date: ' + date + ' | ID: ' + email.messageId);
    console.log('');
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
