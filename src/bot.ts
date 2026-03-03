import { Bot, Context, InputFile } from 'grammy'
import { randomUUID } from 'crypto'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  SCHEDULER_ENABLED,
  WHATSAPP_ENABLED,
} from './config.js'
import { runAgent } from './agent.js'
import { getSession, setSession, clearSession } from './db.js'
import { buildMemoryContext, saveConversationTurn, runDecaySweep } from './memory.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { transcribeAudio, voiceCapabilities } from './voice.js'
import { logger } from './logger.js'

// Scheduler imports (always available)
import {
  createTask,
  getAllTasks,
  getTask,
  deleteTask,
  pauseTask,
  resumeTask,
  getMemoriesForChat,
  deleteAllMemories,
} from './db.js'
import { computeNextRun } from './scheduler.js'

// WhatsApp imports
import {
  getRecentChats,
  sendWaMessage,
  getWaChatMessages,
  mapTelegramToWa,
  getMappedWaChat,
  isWhatsAppReady,
} from './whatsapp.js'

// In-memory voice mode toggle per chat
const voiceModeChats = new Set<string>()

// ── Formatting ─────────────────────────────────────────

/**
 * Convert Markdown to Telegram-compatible HTML.
 */
export function formatForTelegram(text: string): string {
  // Protect code blocks first
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `%%CODE_BLOCK_${idx}%%`
  })

  // Protect inline code
  const inlines: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlines.length
    inlines.push(`<code>${escapeHtml(code)}</code>`)
    return `%%INLINE_${idx}%%`
  })

  // Escape HTML in remaining text (but protect our placeholders)
  result = result.replace(/%%(?:CODE_BLOCK|INLINE)_\d+%%/g, (m) => `\x00${m}\x00`)
  result = escapeHtml(result)
  result = result.replace(/\x00(%%(?:CODE_BLOCK|INLINE)_\d+%%)\x00/g, '$1')

  // Headings → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (but not in the middle of words)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<i>$1</i>')
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  result = result.replace(/- \[ \]/g, '☐')
  result = result.replace(/- \[x\]/g, '☑')

  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Restore code blocks and inline code
  result = result.replace(/%%CODE_BLOCK_(\d+)%%/g, (_m, i) => codeBlocks[parseInt(i)]!)
  result = result.replace(/%%INLINE_(\d+)%%/g, (_m, i) => inlines[parseInt(i)]!)

  return result.trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Split a message at newline boundaries to fit Telegram's limit.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    // Find last newline before limit
    let splitIdx = remaining.lastIndexOf('\n', limit)
    if (splitIdx <= 0) {
      // No newline found, split at last space
      splitIdx = remaining.lastIndexOf(' ', limit)
    }
    if (splitIdx <= 0) {
      // No space either, hard split
      splitIdx = limit
    }

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx + 1)
  }

  return chunks
}

/**
 * Check if a chat ID is authorized.
 * If no ALLOWED_CHAT_IDS configured, allow all (first-run mode).
 */
export function isAuthorised(chatId: string): boolean {
  if (ALLOWED_CHAT_IDS.length === 0) return true
  return ALLOWED_CHAT_IDS.includes(chatId)
}

// ── Main message handler ───────────────────────────────

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = String(ctx.chat?.id)
  if (!chatId || !ctx.chat) return

  if (!isAuthorised(chatId)) {
    await ctx.reply('⛔ Unauthorized. Your chat ID: ' + chatId)
    return
  }

  // Build memory context
  const memoryContext = await buildMemoryContext(chatId, rawText)
  const fullMessage = memoryContext ? `${memoryContext}\n${rawText}` : rawText

  // Get or create session
  const sessionId = getSession(chatId)

  // Typing indicator
  const sendTyping = () => {
    ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
  }

  try {
    const result = await runAgent(fullMessage, sessionId, sendTyping)

    // Update session
    if (result.newSessionId) {
      setSession(chatId, result.newSessionId)
    }

    const responseText = result.text ?? 'No response from Claude.'

    // Save memory
    await saveConversationTurn(chatId, rawText, responseText)

    // Send response
    const formatted = formatForTelegram(responseText)
    const chunks = splitMessage(formatted)

    for (const chunk of chunks) {
      try {
        await ctx.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
      } catch (htmlErr) {
        // Fallback to plain text if HTML parsing fails
        logger.warn({ err: htmlErr }, 'HTML send failed, falling back to plain text')
        await ctx.api.sendMessage(chatId, responseText.slice(0, MAX_MESSAGE_LENGTH))
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Message handling error')
    await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Bot factory ────────────────────────────────────────

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN not set. Run `npm run setup` to configure.'
    )
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  // ── Commands ───────────────────────────────────────

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id)
    await ctx.reply(
      `👋 ClaudeClaw is online.\n\nYour chat ID: <code>${chatId}</code>\n\nI'm connected to the real Claude Code CLI on your machine. Send me anything.`,
      { parse_mode: 'HTML' }
    )
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
    })
  })

  bot.command('newchat', async (ctx) => {
    const chatId = String(ctx.chat.id)
    clearSession(chatId)
    await ctx.reply('🔄 Session cleared. Starting fresh.')
  })

  bot.command('forget', async (ctx) => {
    const chatId = String(ctx.chat.id)
    clearSession(chatId)
    await ctx.reply('🔄 Session cleared. Starting fresh.')
  })

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    const memories = getMemoriesForChat(chatId, 10)
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }

    const lines = memories.map(
      (m, i) =>
        `${i + 1}. [${m.sector}] (salience: ${m.salience.toFixed(2)}) ${m.content.slice(0, 100)}`
    )
    await ctx.reply(`🧠 Recent memories:\n\n${lines.join('\n')}`)
  })

  bot.command('clearMemory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return
    deleteAllMemories(chatId)
    await ctx.reply('🧹 All memories cleared.')
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const caps = voiceCapabilities()

    if (!caps.stt) {
      await ctx.reply('Voice features not configured. Set GROQ_API_KEY in .env.')
      return
    }

    // Voice mode not applicable without TTS, but toggle for future use
    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId)
      await ctx.reply('🔇 Voice mode off. Responses will be text.')
    } else {
      voiceModeChats.add(chatId)
      await ctx.reply('🔊 Voice mode on. (Note: TTS not enabled in this build.)')
    }
  })

  // ── Scheduler commands ─────────────────────────────

  if (SCHEDULER_ENABLED) {
    bot.command('schedule', async (ctx) => {
      const chatId = String(ctx.chat.id)
      if (!isAuthorised(chatId)) return

      const text = ctx.message?.text ?? ''
      const parts = text.replace(/^\/schedule\s*/, '').trim()

      if (!parts || parts === 'list') {
        // List tasks
        const tasks = getAllTasks()
        if (tasks.length === 0) {
          await ctx.reply('No scheduled tasks. Use:\n/schedule create "prompt" "cron"')
          return
        }

        const lines = tasks.map((t) => {
          const status = t.status === 'active' ? '🟢' : '⏸️'
          const next = new Date(t.next_run).toLocaleString()
          return `${status} <code>${t.id}</code>\n   ${t.prompt.slice(0, 60)}\n   ${t.schedule} → next: ${next}`
        })
        await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' })
        return
      }

      // Parse subcommands
      const match = parts.match(/^(create|delete|pause|resume)\s+(.+)/)
      if (!match) {
        await ctx.reply(
          'Usage:\n/schedule list\n/schedule create "prompt" "cron"\n/schedule delete <id>\n/schedule pause <id>\n/schedule resume <id>'
        )
        return
      }

      const [, action, rest] = match

      switch (action) {
        case 'create': {
          // Parse: "prompt" "cron"
          const createMatch = rest.match(/"([^"]+)"\s+"([^"]+)"/)
          if (!createMatch) {
            await ctx.reply('Usage: /schedule create "prompt" "cron expression"')
            return
          }
          const [, prompt, cron] = createMatch
          try {
            const nextRun = computeNextRun(cron)
            const id = randomUUID().slice(0, 8)
            createTask({ id, chat_id: chatId, prompt, schedule: cron, next_run: nextRun, status: 'active' })
            await ctx.reply(
              `✅ Task <code>${id}</code> created\nNext run: ${new Date(nextRun).toLocaleString()}`,
              { parse_mode: 'HTML' }
            )
          } catch (err) {
            await ctx.reply(`Invalid cron expression: ${cron}`)
          }
          break
        }

        case 'delete': {
          const id = rest.trim()
          if (deleteTask(id)) {
            await ctx.reply(`✅ Task ${id} deleted`)
          } else {
            await ctx.reply(`Task ${id} not found`)
          }
          break
        }

        case 'pause': {
          const id = rest.trim()
          if (pauseTask(id)) {
            await ctx.reply(`⏸️ Task ${id} paused`)
          } else {
            await ctx.reply(`Task ${id} not found`)
          }
          break
        }

        case 'resume': {
          const id = rest.trim()
          const task = getTask(id)
          if (!task) {
            await ctx.reply(`Task ${id} not found`)
            return
          }
          const nextRun = computeNextRun(task.schedule)
          if (resumeTask(id, nextRun)) {
            await ctx.reply(
              `▶️ Task ${id} resumed\nNext run: ${new Date(nextRun).toLocaleString()}`
            )
          }
          break
        }
      }
    })
  }

  // ── WhatsApp commands ──────────────────────────────

  if (WHATSAPP_ENABLED) {
    bot.command('wa', async (ctx) => {
      const chatId = String(ctx.chat.id)
      if (!isAuthorised(chatId)) return

      if (!isWhatsAppReady()) {
        await ctx.reply('WhatsApp not connected. Check logs for QR code.')
        return
      }

      const text = (ctx.message?.text ?? '').replace(/^\/wa\s*/, '').trim()

      if (!text || text === 'chats') {
        // List recent chats
        const chats = await getRecentChats(10)
        if (chats.length === 0) {
          await ctx.reply('No WhatsApp chats found.')
          return
        }

        const lines = chats.map(
          (c, i) =>
            `${i + 1}. <b>${escapeHtml(c.name)}</b>\n   ${escapeHtml(c.lastMessage.slice(0, 60))}`
        )
        await ctx.reply(
          `📱 Recent WhatsApp chats:\n\n${lines.join('\n\n')}\n\nReply with /wa select <number> to pick a chat.`,
          { parse_mode: 'HTML' }
        )
        return
      }

      // Select a chat
      const selectMatch = text.match(/^select\s+(\d+)/)
      if (selectMatch) {
        const idx = parseInt(selectMatch[1]) - 1
        const chats = await getRecentChats(10)
        if (idx < 0 || idx >= chats.length) {
          await ctx.reply('Invalid chat number.')
          return
        }
        mapTelegramToWa(chatId, chats[idx].id)
        await ctx.reply(`✅ Linked to: ${chats[idx].name}\nUse /wa read to see messages, /wa send <message> to reply.`)
        return
      }

      // Read messages from linked chat
      if (text === 'read') {
        const waJid = getMappedWaChat(chatId)
        if (!waJid) {
          await ctx.reply('No WhatsApp chat linked. Use /wa to select one.')
          return
        }

        const msgs = getWaChatMessages(waJid, 10)
        if (msgs.length === 0) {
          await ctx.reply('No messages found.')
          return
        }

        const lines = msgs
          .reverse()
          .map((m) => {
            const arrow = m.is_from_me ? '→' : '←'
            const time = new Date(m.timestamp).toLocaleTimeString()
            return `${arrow} [${time}] ${m.sender}: ${m.content.slice(0, 200)}`
          })
        await ctx.reply(lines.join('\n'))
        return
      }

      // Send message
      const sendMatch = text.match(/^send\s+(.+)/s)
      if (sendMatch) {
        const waJid = getMappedWaChat(chatId)
        if (!waJid) {
          await ctx.reply('No WhatsApp chat linked. Use /wa to select one.')
          return
        }
        sendWaMessage(waJid, sendMatch[1])
        await ctx.reply('✅ Message queued.')
        return
      }

      await ctx.reply('Usage: /wa [chats|select N|read|send <message>]')
    })
  }

  // ── Message handlers ───────────────────────────────

  bot.on('message:text', async (ctx) => {
    // Skip commands (already handled)
    if (ctx.message.text.startsWith('/')) return
    await handleMessage(ctx, ctx.message.text)
  })

  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    const caps = voiceCapabilities()
    if (!caps.stt) {
      await ctx.reply('Voice transcription not configured. Set GROQ_API_KEY in .env.')
      return
    }

    try {
      await ctx.api.sendChatAction(chatId, 'typing')
      const file = await ctx.getFile()
      const localPath = await downloadMedia(file.file_id)

      const transcript = await transcribeAudio(localPath)
      logger.info({ chatId, transcript: transcript.slice(0, 100) }, 'Voice transcribed')

      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true)
    } catch (err) {
      logger.error({ err }, 'Voice processing error')
      await ctx.reply(`Voice error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.on('message:photo', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    try {
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(largest.file_id)
      const caption = ctx.message.caption

      await handleMessage(ctx, buildPhotoMessage(localPath, caption))
    } catch (err) {
      logger.error({ err }, 'Photo processing error')
      await ctx.reply(`Photo error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.on('message:document', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    try {
      const doc = ctx.message.document
      const localPath = await downloadMedia(doc.file_id, doc.file_name)
      const caption = ctx.message.caption

      await handleMessage(ctx, buildDocumentMessage(localPath, doc.file_name ?? 'document', caption))
    } catch (err) {
      logger.error({ err }, 'Document processing error')
      await ctx.reply(`Document error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.on('message:video', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    try {
      const video = ctx.message.video
      const localPath = await downloadMedia(video.file_id)
      const caption = ctx.message.caption

      await handleMessage(ctx, buildVideoMessage(localPath, caption))
    } catch (err) {
      logger.error({ err }, 'Video processing error')
      await ctx.reply(`Video error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Error handler
  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error')
  })

  return bot
}

/**
 * Create a sender function for the scheduler.
 */
export function createSender(bot: Bot): (chatId: string, text: string) => Promise<void> {
  return async (chatId: string, text: string) => {
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
      } catch {
        await bot.api.sendMessage(chatId, text.slice(0, MAX_MESSAGE_LENGTH))
      }
    }
  }
}
