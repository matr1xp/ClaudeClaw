---
name: gmail
description: Interact with Gmail - read inbox, search emails, send messages, and manage threads. Triggers on "email", "inbox", "gmail", "send mail", "reply", "search emails".
allowed-tools: Read, Edit, Write, Bash, WebFetch
user-invocable: true
---

# Gmail Skill

Manage Gmail through the Google Gmail API.

## Setup Requirements

1. **Google Cloud Project** with Gmail API enabled
2. **OAuth2 credentials** (Client ID + Client Secret)
3. **Refresh token** for persistent access

## Environment Variables

The following must be set in your project's `.env` file:

```bash
GMAIL_CLIENT_ID=your_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REFRESH_TOKEN=your_refresh_token
GMAIL_USER_EMAIL=your_email@gmail.com
```

## Quick Commands

### Read Inbox
"Check my inbox" | "Read recent emails" | "What emails do I have?"

→ Lists last 10 emails with sender, subject, snippet

### Search Emails
"Search emails from [sender]" | "Find emails about [topic]"

→ Searches Gmail with query syntax support

### Send Email
"Send email to [address] about [subject]" | "Email [person] saying [message]"

→ Composes and sends email

### Reply to Email
"Reply to email [id]" | "Respond to [sender]'s email"

→ Replies to a specific thread

## Gmail Query Syntax

- `from:sender@example.com` - From specific sender
- `subject:keyword` - Subject contains keyword
- `is:unread` - Unread emails only
- `after:2024/01/01` - After date
- `has:attachment` - Has attachments
- `label:important` - In specific label

## Implementation

When triggered:

1. **Check auth**: Verify GMAIL_REFRESH_TOKEN exists in env
2. **Fetch tokens**: Use refresh token to get access token
3. **Execute action**: Call Gmail API based on user intent
4. **Format output**: Present clean email summary

## Response Format

**Inbox listing:**
```
📧 3 unread | 10 total

1. [UNREAD] From: Sender Name <sender@example.com>
   Subject: Meeting tomorrow
   Preview: Hey, just wanted to confirm...
   ID: 18abc123

2. From: Another Person <other@example.com>
   Subject: Project update
   Preview: Here's the latest on...
   ID: 18def456
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
   Message ID: <abc123@mail.gmail.com>
```

## Error Handling

- **Auth expired**: "Gmail authentication expired. Run refresh-gmail-auth to reconnect."
- **Rate limited**: "Gmail rate limit hit. Try again in a few minutes."
- **Send failed**: "Failed to send. Check recipient address and try again."

## Security Notes

- Never log email content to console in production
- Tokens stored only in `.env`, never committed
- Read-only scope available if sending not needed
- Revoke access at: https://myaccount.google.com/permissions
