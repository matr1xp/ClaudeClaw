---
name: zoho-mail
description: Interact with Zoho Mail - read inbox, search emails, send messages, manage folders, and handle attachments. Triggers on "zoho mail", "zoho email", "zoho inbox", "check zoho", "send zoho email".
allowed-tools: Read, Edit, Write, Bash, WebFetch
user-invocable: true
---

# Zoho Mail Skill

Manage Zoho Mail through the Zoho Mail API.

## Setup Requirements

1. **Zoho Developer Console** account at https://accounts.zoho.com/developerconsole
2. **Self Client** or **Server-based Application** with OAuth2 credentials
3. **Refresh token** for persistent access
4. **Account ID** from Zoho Mail

## Environment Variables

The following must be set in your project's `.env` file:

```bash
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_REFRESH_TOKEN=your_refresh_token
ZOHO_ACCOUNT_ID=your_account_id
ZOHO_FROM_EMAIL=your_email@zohomail.com
ZOHO_DATA_CENTER=com  # Options: com, eu, in, cn, com.au
```

### Data Center Options

- `com` - US (accounts.zoho.com)
- `eu` - Europe (accounts.zoho.eu)
- `in` - India (accounts.zoho.in)
- `cn` - China (accounts.zoho.com.cn)
- `com.au` - Australia (accounts.zoho.com.au)

## Quick Commands

### Read Inbox
"Check my Zoho inbox" | "Read recent Zoho emails" | "What emails in Zoho?"

→ Lists last 10 emails with sender, subject, snippet

### Search Emails
"Search Zoho emails from [sender]" | "Find Zoho emails about [topic]"

→ Searches Zoho Mail with query syntax support

### Send Email
"Send Zoho email to [address] about [subject]" | "Email from Zoho [person] saying [message]"

→ Composes and sends email

### Reply to Email
"Reply to Zoho email [id]" | "Respond to [sender]'s Zoho email"

→ Replies to a specific email

### Manage Folders
"List Zoho Mail folders" | "Create folder [name]" | "Delete folder [id]"

→ Manage mail folders

### Handle Attachments
"Download attachment [id] from email [id]" | "Send email with attachment"

→ Download or send attachments

## Zoho Mail Search Syntax

- `from:sender@example.com` - From specific sender
- `subject:keyword` - Subject contains keyword
- `is:unread` - Unread emails only
- `after:2024/01/01` - After date
- `has:attachment` - Has attachments
- `in:folder` - In specific folder

## Implementation

When triggered:

1. **Check auth**: Verify ZOHO_REFRESH_TOKEN exists in env
2. **Fetch tokens**: Use refresh token to get access token
3. **Execute action**: Call Zoho Mail API based on user intent
4. **Format output**: Present clean email summary

## Response Format

**Inbox listing:**
```
📧 3 unread | 10 total

1. [UNREAD] From: Sender Name <sender@example.com>
   Subject: Meeting tomorrow
   Preview: Hey, just wanted to confirm...
   ID: 123456789
   Folder: Inbox

2. From: Another Person <other@example.com>
   Subject: Project update
   Preview: Here's the latest on...
   ID: 987654321
```

**Search results:**
```
🔍 Found 5 emails matching "from:boss@company.com"

1. Subject: Q4 Planning
   Date: Jan 15, 2024
   Snippet: Let's discuss the quarterly...
```

**Send confirmation:**
```
✅ Email sent to: recipient@example.com
   Subject: Your subject here
   Message ID: abc123
```

**Folder listing:**
```
📁 Folders:

1. Inbox (42 messages)
   ID: 123456

2. Sent (156 messages)
   ID: 123457

3. Drafts (3 messages)
   ID: 123458
```

## Error Handling

- **Auth expired**: "Zoho authentication expired. Run auth.js to reconnect."
- **Rate limited**: "Zoho rate limit hit. Try again in a few minutes."
- **Send failed**: "Failed to send. Check recipient address and try again."

## Security Notes

- Never log email content to console in production
- Tokens stored only in `.env`, never committed
- Read-only scope available if sending not needed
- Revoke access at: https://accounts.zoho.com/home#security/authorizedapps
