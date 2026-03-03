# ClaudeClaw

A personal AI assistant that runs as a persistent service, accessible via Telegram and WhatsApp. Powered by Claude and designed for autonomous task execution with memory and scheduling capabilities.

## Features

- **Multi-platform messaging**: Works with both Telegram and WhatsApp
- **Autonomous agent capabilities**: Uses Claude Agent SDK for complex task execution
- **Persistent memory**: SQLite-based memory system for context across conversations
- **Task scheduling**: Cron-based scheduling for recurring tasks and reminders
- **Built-in skills**: Gmail, Google Calendar, todo management, web browsing, and parallel task execution
- **Voice message support**: Transcribes and processes voice messages
- **Media handling**: Processes images and documents sent via chat

## Architecture

```
ClaudeClaw/
├── src/
│   ├── bot.ts           # Main bot orchestrator (Telegram/WhatsApp)
│   ├── agent.ts         # Claude Agent SDK integration
│   ├── scheduler.ts     # Cron-based task scheduling
│   ├── schedule-cli.ts  # CLI for managing scheduled tasks
│   ├── db.ts            # SQLite database layer
│   ├── memory.ts        # Memory/persistence utilities
│   ├── media.ts         # Media processing (images, voice)
│   ├── voice.ts         # Voice message transcription
│   ├── whatsapp.ts      # WhatsApp Web integration
│   ├── config.ts        # Configuration management
│   ├── env.ts           # Environment variable validation
│   ├── logger.ts        # Logging utilities
│   └── index.ts         # Application entry point
├── scripts/
│   ├── setup.ts         # Initial setup wizard
│   ├── status.ts        # Service status checker
│   └── notify.sh        # Desktop notification helper
└── CLAUDE.md            # Claude personality/instructions
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Anthropic API key
- Telegram Bot Token (from @BotFather)
- (Optional) WhatsApp for WhatsApp integration

### Installation

```bash
# Clone and install dependencies
npm install

# Run setup wizard
npm run setup
```

The setup wizard will:
1. Create `.env` file with required variables
2. Initialize the SQLite database
3. Set up Telegram webhook (optional)
4. Configure WhatsApp session

### Environment Variables

Create `.env` file:

```env
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# Optional
WHATSAPP_ENABLED=true
GOOGLE_API_KEY=your_gemini_api_key
DB_PATH=./data/claudeclaw.db
LOG_LEVEL=info
```

### Running

```bash
# Development mode
npm run dev

# Build and run production
npm run build
npm start

# Check service status
npm run status
```

## Usage

### Telegram

1. Start a chat with your bot
2. Send messages naturally - ClaudeClaw will respond
3. Send voice messages for hands-free interaction
4. Share images or documents for analysis

### WhatsApp

1. Scan the QR code displayed in terminal on first run
2. Your WhatsApp account becomes the bot
3. Anyone messaging that number gets ClaudeClaw responses

### Scheduling Tasks

Schedule recurring tasks via CLI:

```bash
# Daily at 9am
npm run schedule -- create "Check emails and summarize" "0 9 * * *" YOUR_CHAT_ID

# Every 4 hours
npm run schedule -- create "Check calendar for upcoming events" "0 */4 * * *" YOUR_CHAT_ID

# Every Monday at 9am
npm run schedule -- create "Weekly planning session" "0 9 * * 1" YOUR_CHAT_ID
```

List or delete scheduled tasks:
```bash
npm run schedule -- list
npm run schedule -- delete <task-id>
```

## Available Skills

| Skill | Description | Example Trigger |
|-------|-------------|-----------------|
| `gmail` | Read/send emails | "Check my inbox", "Send an email to..." |
| `google-calendar` | Check/create events | "What's on my calendar today?" |
| `todo` | Task management | "Add to my todo list...", "What's on my plate?" |
| `agent-browser` | Web browsing/scraping | "Look up...", "Go to...", "Search for..." |
| `maestro` | Parallel task execution | "Do X, Y, and Z at the same time" |

## Commands

Special commands recognized by ClaudeClaw:

- `convolife` - Check remaining context window usage
- `checkpoint` - Save session summary to database

## Development

```bash
# Run type checker
npm run typecheck

# Run tests
npm test

# Build
npm run build
```

## Project Structure Notes

- **CLAUDE.md**: Defines ClaudeClaw's personality, rules, and available capabilities. Read at session start.
- **obsidian/**: Optional Obsidian vault integration for knowledge management
- **data/**: SQLite database and session files (created at runtime)

## License

Private - For personal use only.
