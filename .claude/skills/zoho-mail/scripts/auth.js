#!/usr/bin/env node
import http from 'http';
import url from 'url';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import open from 'open';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const DATA_CENTERS = {
  com: { accounts: 'accounts.zoho.com', api: 'mail.zoho.com' },
  eu: { accounts: 'accounts.zoho.eu', api: 'mail.zoho.eu' },
  in: { accounts: 'accounts.zoho.in', api: 'mail.zoho.in' },
  cn: { accounts: 'accounts.zoho.com.cn', api: 'mail.zoho.com.cn' },
  'com.au': { accounts: 'accounts.zoho.com.au', api: 'mail.zoho.com.au' }
};

const SCOPES = [
  'ZohoMail.accounts.READ',
  'ZohoMail.folders.ALL',
  'ZohoMail.messages.ALL',
  'ZohoMail.attachments.ALL'
].join(',');

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  const env = {};
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim();
      }
    }
  }
  return env;
}

function getDataCenter(env) {
  const dc = env.ZOHO_DATA_CENTER || 'com';
  return DATA_CENTERS[dc] || DATA_CENTERS.com;
}

function updateEnvFile(updates) {
  const envPath = resolve(process.cwd(), '.env');
  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
  }
  const lines = content.split('\n');
  const existingKeys = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([^#=]+)=/);
    if (match) {
      const key = match[1].trim();
      existingKeys.add(key);
      if (updates[key] !== undefined) {
        lines[i] = `${key}=${updates[key]}`;
        delete updates[key];
      }
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!existingKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }
  writeFileSync(envPath, lines.join('\n'));
  console.log(`Updated ${envPath}`);
}

async function getTokensFromCode(code, dc, env, redirectUri) {
  const tokenUrl = `https://${dc.accounts}/oauth/v2/token`;
  const params = new URLSearchParams();
  params.append('code', code);
  params.append('grant_type', 'authorization_code');
  params.append('client_id', env.ZOHO_CLIENT_ID);
  params.append('client_secret', env.ZOHO_CLIENT_SECRET);
  params.append('redirect_uri', redirectUri);

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data;
}

async function startOAuthFlow() {
  const env = loadEnv();
  const dc = getDataCenter(env);

  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    console.error('Error: ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  const redirectUri = 'http://localhost:3000/oauth/callback';
  const state = Math.random().toString(36).substring(7);

  const authUrl = new URL(`https://${dc.accounts}/oauth/v2/auth`);
  authUrl.searchParams.append('client_id', env.ZOHO_CLIENT_ID);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('scope', SCOPES);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('access_type', 'offline');
  authUrl.searchParams.append('prompt', 'consent');

  console.log('\nZoho Mail OAuth Setup\n');
  console.log('Opening browser for authorization...');
  open(authUrl.toString());

  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/oauth/callback') {
      const code = parsedUrl.query.code;
      const error = parsedUrl.query.error;
      const returnedState = parsedUrl.query.state;

      if (error) {
        res.end(`Authorization Failed: ${error}`);
        console.error('Authorization failed:', error);
        server.close();
        process.exit(1);
      }

      if (!code) {
        res.end('No authorization code received');
        console.error('No code received');
        server.close();
        process.exit(1);
      }

      if (returnedState !== state) {
        res.end('State mismatch');
        console.error('State mismatch');
        server.close();
        process.exit(1);
      }

      try {
        const tokenData = await getTokensFromCode(code, dc, env, redirectUri);
        const { refresh_token, access_token } = tokenData;

        // Use mail.zoho.com API domain, not the generic api_domain from token response
        const accountsUrl = `https://${dc.api}/api/accounts`;
        const accountsResponse = await axios.get(accountsUrl, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });

        const accounts = accountsResponse.data.data || [];
        const primaryAccount = accounts[0];

        if (!primaryAccount) {
          throw new Error('No Zoho Mail account found');
        }

        const accountId = primaryAccount.accountId;
        const fromEmail = primaryAccount.primaryEmailAddress || primaryAccount.emailAddress;

        updateEnvFile({
          ZOHO_REFRESH_TOKEN: refresh_token,
          ZOHO_ACCOUNT_ID: accountId,
          ZOHO_FROM_EMAIL: fromEmail
        });

        res.end('Authorization successful! You can close this window.');
        console.log('\nAuthorization successful!');
        console.log(`Account: ${fromEmail}`);
        console.log(`Account ID: ${accountId}`);
        server.close();
        process.exit(0);

      } catch (error) {
        console.error('Token exchange error:', error.response?.data || error.message);
        res.end(`Token exchange failed: ${error.message}`);
        server.close();
        process.exit(1);
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(3000);

  setTimeout(() => {
    console.error('Timeout: Authorization not completed within 5 minutes');
    server.close();
    process.exit(1);
  }, 5 * 60 * 1000);
}

async function refreshToken() {
  const env = loadEnv();
  const dc = getDataCenter(env);

  if (!env.ZOHO_REFRESH_TOKEN) {
    console.error('Error: No refresh token found. Run auth.js first.');
    process.exit(1);
  }

  try {
    const tokenUrl = `https://${dc.accounts}/oauth/v2/token`;
    const params = new URLSearchParams();
    params.append('refresh_token', env.ZOHO_REFRESH_TOKEN);
    params.append('grant_type', 'refresh_token');
    params.append('client_id', env.ZOHO_CLIENT_ID);
    params.append('client_secret', env.ZOHO_CLIENT_SECRET);

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('Token refresh successful');
    console.log(`Access Token: ${response.data.access_token.substring(0, 20)}...`);
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data?.error || error.message);
    process.exit(1);
  }
}

async function testConnection() {
  const env = loadEnv();
  const dc = getDataCenter(env);

  if (!env.ZOHO_REFRESH_TOKEN) {
    console.error('Error: ZOHO_REFRESH_TOKEN not set. Run auth.js first.');
    process.exit(1);
  }

  try {
    const tokenUrl = `https://${dc.accounts}/oauth/v2/token`;
    const params = new URLSearchParams();
    params.append('refresh_token', env.ZOHO_REFRESH_TOKEN);
    params.append('grant_type', 'refresh_token');
    params.append('client_id', env.ZOHO_CLIENT_ID);
    params.append('client_secret', env.ZOHO_CLIENT_SECRET);

    const tokenResponse = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenResponse.data.access_token;
    const apiUrl = `https://${dc.api}/api/accounts/${env.ZOHO_ACCOUNT_ID}/folders`;
    
    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    console.log('Connection successful!');
    console.log(`Folders: ${response.data.data?.length || 0}`);
  } catch (error) {
    console.error('Connection failed:', error.response?.data?.message || error.message);
    process.exit(1);
  }
}

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'auth':
    case 'login':
      await startOAuthFlow();
      break;
    case 'refresh':
      await refreshToken();
      break;
    case 'test':
      await testConnection();
      break;
    default:
      console.log('Usage: auth.js auth|refresh|test');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
