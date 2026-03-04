const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

async function getMessage() {
  const list = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
    q: 'is:unread'
  });

  if (!list.data.messages || list.data.messages.length === 0) {
    console.log('No unread messages');
    return;
  }

  // Get first unread message
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: list.data.messages[0].id,
    format: 'full'
  });

  const headers = msg.data.payload.headers;
  const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
  const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
  const date = headers.find(h => h.name === 'Date')?.value || 'Unknown';

  let body = '';
  if (msg.data.payload.parts) {
    const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
    const htmlPart = msg.data.payload.parts.find(p => p.mimeType === 'text/html');
    if (textPart) {
      body = Buffer.from(textPart.body.data, 'base64').toString();
    } else if (htmlPart) {
      body = Buffer.from(htmlPart.body.data, 'base64').toString();
    }
  } else if (msg.data.payload.body?.data) {
    body = Buffer.from(msg.data.payload.body.data, 'base64').toString();
  }

  console.log('From:', from);
  console.log('Subject:', subject);
  console.log('Date:', date);
  console.log('---');
  console.log(body || '(No text body)');
}

getMessage().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
