# ClaudeClaw

A Telegram bot powered by Claude AI, featuring voice transcription, task scheduling, WhatsApp bridging, and persistent memory.

## Features

- **Claude AI Integration** - Uses the Claude Agent SDK for intelligent responses
- **Voice Messages** - Transcribes voice messages using Groq STT; replies as voice using Groq TTS
- **Task Scheduler** - Schedule recurring tasks with cron expressions
- **WhatsApp Bridge** - Forward WhatsApp messages to Telegram (optional)
- **Persistent Memory** - SQLite-based conversation history with automatic decay
- **Media Support** - Handles photos, documents, and videos
- **Session Management** - Per-chat conversation contexts

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
npm run setup

# Start the bot
npm start
```

## Configuration

Create a `.env` file with:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_CHAT_IDS=123456789,987654321
GOOGLE_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
TTS_VOICE=Celeste-PlayAI           # optional, see .env.example for all voices
WHATSAPP_ENABLED=false
SCHEDULER_ENABLED=true
```

## Commands

| Command             | Description                      |
| ------------------- | -------------------------------- |
| `npm run setup`     | Interactive configuration wizard |
| `npm run status`    | Check bot and scheduler status   |
| `npm start`         | Run the bot                      |
| `npm run dev`       | Run in development mode          |
| `npm run schedule`  | Manage scheduled tasks           |
| `npm run typecheck` | Run TypeScript checks            |

## Scheduled Tasks

Schedule recurring prompts:

```bash
# Daily at 9am
npm run schedule create "Check emails" "0 9 * * *" 123456789

# Every Monday 9am
npm run schedule create "Weekly report" "0 9 * * 1" 123456789

# Every 4 hours
npm run schedule create "Status check" "0 */4 * * *" 123456789
```

## Bot Commands (in Telegram)

- `/voice` - Toggle voice mode (responses as voice messages via Groq TTS)
- `/status` - Check bot status
- `/tasks` - List scheduled tasks
- `/memory` - View stored memories
- `/checkpoint` - Save session summary
- `/convolife` - Check context window usage

## Project Structure

```
├── src/
│   ├── index.ts          # Entry point
│   ├── bot.ts            # Telegram bot logic
│   ├── agent.ts          # Claude Agent SDK integration
│   ├── config.ts         # Environment configuration
│   ├── db.ts             # SQLite database operations
│   ├── memory.ts         # Memory decay and context
│   ├── scheduler.ts      # Cron task scheduler
│   ├── whatsapp.ts       # WhatsApp bridge
│   ├── voice.ts          # Voice transcription
│   └── media.ts          # Media handling
├── scripts/
│   ├── setup.ts          # Configuration wizard
│   └── notify.sh         # Desktop notifications
└── store/                # SQLite database & files
```

## Requirements

- Node.js >= 20
- Telegram Bot Token (from @BotFather)
- Gemini API Key (for embeddings)
- Groq API Key (for voice transcription)

## Troubleshooting

### Tail the logs

The service writes stdout and stderr to `/tmp/claudeclaw.log`:

```bash
tail -f /tmp/claudeclaw.log
```

### Service management

```bash
# Check if service is loaded (exit code 1 = not loaded)
launchctl list | grep claudeclaw

# Reload after a build or config change
launchctl unload ~/Library/LaunchAgents/com.claudeclaw.app.plist
launchctl load  ~/Library/LaunchAgents/com.claudeclaw.app.plist

# Check status reported by the bot
npm run status
```

### Bot is unresponsive / crash-looping

Check `/tmp/claudeclaw.log` for the error. Common causes:

| Error | Fix |
|---|---|
| `ERR_DLOPEN_FAILED` — `better-sqlite3` compiled for wrong Node version | `npm rebuild better-sqlite3` then reload service |
| `TELEGRAM_BOT_TOKEN not set` | Run `npm run setup` or check `.env` |
| `Claude CLI not found` | Ensure `claude` is on the PATH in the plist `EnvironmentVariables` |

### Node.js version upgrade

After upgrading Node.js, native modules must be rebuilt before restarting:

```bash
npm rebuild
launchctl unload ~/Library/LaunchAgents/com.claudeclaw.app.plist
launchctl load  ~/Library/LaunchAgents/com.claudeclaw.app.plist
```

### Check context window usage

Send `/convolife` in Telegram to see how full the Claude session context window is. When >80%, use `/checkpoint` then `/newchat` to reset cleanly.

## License

MIT
