import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  TELEGRAM_BOT_TOKEN,
  PROJECT_ROOT,
  STORE_DIR,
  UPLOADS_DIR,
  SCHEDULER_ENABLED,
  WHATSAPP_ENABLED,
  MEMORY_DECAY_INTERVAL_MS,
} from './config.js'
import { initDatabase, closeDatabase, startWalCheckpoints } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot, createSender } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { initWhatsApp, stopWhatsApp, isWhatsAppReady } from './whatsapp.js'
import { logger } from './logger.js'

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`

const PID_FILE = resolve(STORE_DIR, 'claudeclaw.pid')

// ── Lock management ────────────────────────────────────

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // Check if alive
        logger.warn({ oldPid }, 'Killing stale instance')
        process.kill(oldPid, 'SIGTERM')
        // Give it a moment to die
        const start = Date.now()
        while (Date.now() - start < 2000) {
          try {
            process.kill(oldPid, 0)
          } catch {
            break
          }
        }
      } catch {
        // Process doesn't exist, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.info({ pid: process.pid }, 'Lock acquired')
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE)
    }
  } catch {
    // Best effort
  }
}

// ── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
  // Banner
  console.log(BANNER)

  // Check token
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('\n❌ TELEGRAM_BOT_TOKEN not set.')
    console.error('   Run `npm run setup` to configure.\n')
    process.exit(1)
  }

  // Lock
  acquireLock()

  // Init database
  initDatabase()
  startWalCheckpoints()

  // Ensure directories
  mkdirSync(UPLOADS_DIR, { recursive: true })

  // Memory decay sweep (run now + daily)
  runDecaySweep()
  const decayInterval = setInterval(runDecaySweep, MEMORY_DECAY_INTERVAL_MS)

  // Cleanup old uploads
  cleanupOldUploads()

  // Create bot
  const bot = createBot()
  const sender = createSender(bot)

  // Scheduler
  if (SCHEDULER_ENABLED) {
    initScheduler(sender)
    logger.info('Scheduler enabled')
  }

  // WhatsApp bridge
  if (WHATSAPP_ENABLED) {
    initWhatsApp(async (chatJid, senderName, content) => {
      // Forward incoming WhatsApp messages to all allowed chats
      const notification = `📱 WhatsApp from <b>${senderName}</b>:\n${content}`
      const { ALLOWED_CHAT_IDS } = await import('./config.js')
      for (const chatId of ALLOWED_CHAT_IDS) {
        await sender(chatId, notification)
      }
    })
    logger.info('WhatsApp bridge enabled')
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(decayInterval)
    stopScheduler()
    if (WHATSAPP_ENABLED) stopWhatsApp()
    await bot.stop()
    closeDatabase()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start
  try {
    await bot.start({
      onStart: () => {
        logger.info('ClaudeClaw running')
      },
    })
  } catch (err) {
    logger.error({ err }, 'Failed to start bot')
    console.error('\n❌ Failed to start bot. Check your TELEGRAM_BOT_TOKEN in .env\n')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
