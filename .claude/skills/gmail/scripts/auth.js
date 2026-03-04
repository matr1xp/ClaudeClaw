#!/usr/bin/env node
/**
 * Gmail OAuth2 Authentication Setup
 * Run this to get your refresh token
 */

import { google } from 'googleapis';
import { createServer } from 'http';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

console.log(`
╔══════════════════════════════════════╗
║     Gmail Skill Auth Setup           ║
╚══════════════════════════════════════╝

This script will help you get a Gmail refresh token.
You'll need to create a Google Cloud Project first.
`);

console.log(`Setup steps:
1. Go to https://console.cloud.google.com/
2. Create a new project (or use existing)
3. Enable the Gmail API:
   - APIs & Services → Library → Search "Gmail API" → Enable
4. Create OAuth2 credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: "Desktop app"
   - Name: "ClaudeClaw Gmail"
   - Download the client JSON (you'll need client_id and client_secret)
5. Add yourself as a test user:
   - OAuth consent screen → Audience → Add test users
   - Add your Gmail address

`);

async function main() {
  const envPath = resolve(process.cwd(), '.env');

  // Check if .env exists
  if (!existsSync(envPath)) {
    console.error('Error: .env file not found in current directory');
    process.exit(1);
  }

  // Read existing env
  let envContent = readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }

  // Get credentials
  const clientId = await ask('Enter your Client ID: ');
  const clientSecret = await ask('Enter your Client Secret: ');
  const userEmail = await ask('Enter your Gmail address: ');

  if (!clientId || !clientSecret) {
    console.error('Error: Client ID and Secret are required');
    process.exit(1);
  }

  // Create OAuth client
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3000/oauth2callback'
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    prompt: 'consent'  // Force to get refresh token
  });

  console.log(`\n🔐 Authorization URL:`);
  console.log(authUrl);

  console.log(`\n👉 Open this URL in your browser and authorize access`);
  console.log(`👉 You'll be redirected to localhost:3000 (it will show an error, that's OK)`);
  console.log(`👉 Copy the "code" parameter from the URL\n`);

  // Start local server to capture callback
  const codePromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>✅ Success!</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('No code received');
      }
    }).listen(3000);

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for authorization'));
    }, 120000);
  });

  // Also ask user to paste code directly as fallback
  const directCode = await ask('Paste the code here (or wait for auto-capture): ');

  let code;
  if (directCode.trim()) {
    code = directCode.trim();
  } else {
    try {
      code = await codePromise;
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }

  // Exchange code for tokens
  try {
    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n✅ Successfully obtained tokens!\n');

    // Update .env file
    const envLines = envContent.split('\n').filter(line => {
      const key = line.split('=')[0];
      return key !== 'GMAIL_CLIENT_ID' && key !== 'GMAIL_CLIENT_SECRET'
        && key !== 'GMAIL_REFRESH_TOKEN' && key !== 'GMAIL_USER_EMAIL';
    });

    envLines.push(`GMAIL_CLIENT_ID=${clientId}`);
    envLines.push(`GMAIL_CLIENT_SECRET=${clientSecret}`);
    envLines.push(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    envLines.push(`GMAIL_USER_EMAIL=${userEmail}`);

    writeFileSync(envPath, envLines.join('\n') + '\n');

    console.log('Updated .env with:');
    console.log(`  GMAIL_CLIENT_ID=${clientId.substring(0, 10)}...`);
    console.log(`  GMAIL_CLIENT_SECRET=${clientSecret.substring(0, 10)}...`);
    console.log(`  GMAIL_REFRESH_TOKEN=${tokens.refresh_token.substring(0, 20)}...`);
    console.log(`  GMAIL_USER_EMAIL=${userEmail}`);

    console.log('\n✅ Gmail skill is now configured!');
    console.log('Test it: say "check my inbox" to your bot\n');

  } catch (err) {
    console.error('Error getting tokens:', err.message);
    process.exit(1);
  }

  rl.close();
}

main().catch(console.error);
