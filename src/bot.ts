import { Bot, Context, InputFile } from 'grammy'
import { randomUUID } from 'crypto'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  SCHEDULER_ENABLED,
  WHATSAPP_ENABLED,
  PROJECT_ROOT,
} from './config.js'
import { runAgent } from './agent.js'
import { getSession, setSession, clearSession } from './db.js'
import { buildMemoryContext, saveConversationTurn, runDecaySweep } from './memory.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { transcribeAudio, synthesizeAudio, voiceCapabilities } from './voice.js'
import { logger } from './logger.js'

import {
  createTask,
  getAllTasks,
  getTask,
  deleteTask,
  pauseTask,
  resumeTask,
  getMemoriesForChat,
  deleteAllMemories,
  getDb,
  saveMemory,
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

import { hasScheduleIntent, parseScheduleNL } from './schedule-parse.js'

// In-memory voice mode toggle per chat
const voiceModeChats = new Set<string>()

// Bot start time (for uptime display)
const BOT_START = Date.now()

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

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
  voiceReply = false
): Promise<void> {
  const chatId = String(ctx.chat?.id)
  if (!chatId || !ctx.chat) return

  if (!isAuthorised(chatId)) {
    await ctx.reply('⛔ Unauthorized. Your chat ID: ' + chatId)
    return
  }

  // Typing indicator helper
  const sendTyping = () => {
    ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
  }

  // Intercept natural language scheduling intents
  if (SCHEDULER_ENABLED && hasScheduleIntent(rawText)) {
    sendTyping()
    const parsed = await parseScheduleNL(rawText)
    if (parsed) {
      try {
        const nextRun = computeNextRun(parsed.cron)
        const id = randomUUID().slice(0, 8)
        createTask({ id, chat_id: chatId, prompt: parsed.prompt, schedule: parsed.cron, next_run: nextRun, status: 'active' })
        await ctx.reply(
          `✅ <b>Scheduled task created automatically</b>\n\n📌 ${parsed.prompt}\n⏰ Cron: <code>${parsed.cron}</code>\n⏭ Next run: ${new Date(nextRun).toLocaleString()}`,
          { parse_mode: 'HTML' }
        )
        return // Short-circuit, we handled it
      } catch (err) {
        logger.error({ err, cron: parsed.cron }, 'Failed to schedule auto-detected intent')
      }
    }
  }

  // Build memory context
  const memoryContext = await buildMemoryContext(chatId, rawText)
  const fullMessage = memoryContext ? `${memoryContext}\n${rawText}` : rawText

  // Get or create session
  const sessionId = getSession(chatId)

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
    const shouldVoice = voiceReply || voiceModeChats.has(chatId)

    if (shouldVoice && voiceCapabilities().tts) {
      try {
        // Synthesize and send as voice message
        await ctx.api.sendChatAction(chatId, 'record_voice')
        // Strip HTML tags for clean TTS input
        const plainText = responseText.replace(/<[^>]+>/g, '').trim()
        const audioPath = await synthesizeAudio(plainText)
        const { createReadStream } = await import('fs')
        await ctx.api.sendVoice(chatId, new InputFile(createReadStream(audioPath)))
        // Also send text so the content is searchable / copy-able
        const formatted = formatForTelegram(responseText)
        const chunks = splitMessage(formatted)
        for (const chunk of chunks) {
          try {
            await ctx.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
          } catch {
            await ctx.api.sendMessage(chatId, responseText.slice(0, MAX_MESSAGE_LENGTH))
          }
        }
      } catch (ttsErr) {
        logger.warn({ err: ttsErr }, 'TTS failed, falling back to text-only reply')
        const formatted = formatForTelegram(responseText)
        const chunks = splitMessage(formatted)
        for (const chunk of chunks) {
          try {
            await ctx.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
          } catch {
            await ctx.api.sendMessage(chatId, responseText.slice(0, MAX_MESSAGE_LENGTH))
          }
        }
      }
    } else {
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

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    const caps = voiceCapabilities()
    const tasks = getAllTasks()
    const activeTasks = tasks.filter((t) => t.status === 'active').length
    const uptime = formatUptime(Date.now() - BOT_START)

    // DB stats
    const db = getDb()
    const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c
    const memoryCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c

    const voiceIcon = voiceModeChats.has(chatId) ? '🔊 on' : '🔇 off'

    const lines = [
      `<b>🤖 ClaudeClaw Status</b>`,
      ``,
      `<b>⏱ Uptime:</b> ${uptime}`,
      `<b>🖥 Node:</b> ${process.version}`,
      ``,
      `<b>🎙 STT (Groq):</b> ${caps.stt ? '✅ ready' : '❌ not configured'}`,
      `<b>🔈 TTS (Orpheus):</b> ${caps.tts ? '✅ ready' : '❌ not configured'}`,
      `<b>🗣 Voice mode:</b> ${voiceIcon}`,
      ``,
      `<b>🗓 Scheduler:</b> ${SCHEDULER_ENABLED ? `✅ ${activeTasks} active / ${tasks.length} total` : '⏸ disabled'}`,
      `<b>📱 WhatsApp:</b> ${WHATSAPP_ENABLED ? '✅ enabled' : '⏸ disabled'}`,
      ``,
      `<b>🧠 Memories:</b> ${memoryCount}`,
      `<b>💬 Sessions:</b> ${sessionCount}`,
    ]

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  bot.command('checkpoint', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    await ctx.reply('💾 Saving checkpoint...')
    await ctx.api.sendChatAction(chatId, 'typing')

    try {
      const sessionId = getSession(chatId)
      const result = await runAgent(
        'Write a 3-5 bullet summary of the key decisions, findings, and context from our conversation so far. Be terse. Format as plain bullet points (- item). This will be saved as a memory checkpoint.',
        sessionId
      )

      const summary = result.text ?? 'No summary produced.'

      // Save as high-salience semantic memory (salience 5.0 = max)
      getDb()
        .prepare(
          `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
           VALUES (?, ?, ?, 'semantic', 5.0, ?, ?)`
        )
        .run(chatId, 'checkpoint', `[Checkpoint] ${summary}`, Date.now(), Date.now())

      await ctx.reply(
        `✅ <b>Checkpoint saved.</b>\n\n${summary}\n\n<i>Safe to /newchat — this summary will persist.</i>`,
        { parse_mode: 'HTML' }
      )
    } catch (err) {
      logger.error({ err }, '/checkpoint error')
      await ctx.reply(`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.command('convolife', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    try {
      const { readdirSync, readFileSync, statSync } = await import('fs')
      const { join, sep } = await import('path')
      const { homedir } = await import('os')

      // Claude stores sessions at ~/.claude/projects/<project-path-with-hyphens>/
      // Project path is PROJECT_ROOT with slashes replaced by hyphens
      const projectSlug = PROJECT_ROOT.split(sep).filter(Boolean).join('-')
      const sessionDir = join(homedir(), '.claude', 'projects', projectSlug)

      let latestFile: string | null = null
      let latestMtime = 0

      try {
        const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
        for (const f of files) {
          const fullPath = join(sessionDir, f)
          const mtime = statSync(fullPath).mtimeMs
          if (mtime > latestMtime) {
            latestMtime = mtime
            latestFile = fullPath
          }
        }
      } catch {
        // dir may not exist yet
      }

      if (!latestFile) {
        await ctx.reply('📊 No session data found yet. Start a conversation first.')
        return
      }

      // Scan JSONL for the last cache_read_input_tokens value
      const lines = readFileSync(latestFile, 'utf-8').trim().split('\n')
      let lastTokens = 0
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          const val =
            obj?.message?.usage?.cache_read_input_tokens ??
            obj?.usage?.cache_read_input_tokens ??
            obj?.cache_read_input_tokens
          if (typeof val === 'number') lastTokens = val
        } catch {
          // skip malformed lines
        }
      }

      const CONTEXT_LIMIT = 200_000
      const pct = ((lastTokens / CONTEXT_LIMIT) * 100).toFixed(1)
      const remaining = Math.max(0, CONTEXT_LIMIT - lastTokens)
      const remainingK = (remaining / 1000).toFixed(0)

      // Visual bar (10 segments)
      const filled = Math.round(parseFloat(pct) / 10)
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)

      let health = '🟢'
      if (parseFloat(pct) > 80) health = '🔴'
      else if (parseFloat(pct) > 60) health = '🟡'

      await ctx.reply(
        `${health} <b>Context window: ${pct}% used</b>\n` +
          `<code>[${bar}]</code>\n` +
          `~${remainingK}k tokens remaining of ${(CONTEXT_LIMIT / 1000).toFixed(0)}k\n\n` +
          `<i>Use /checkpoint then /newchat to reset.</i>`,
        { parse_mode: 'HTML' }
      )
    } catch (err) {
      logger.error({ err }, '/convolife error')
      await ctx.reply(`Error reading context info: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const caps = voiceCapabilities()

    if (!caps.stt) {
      await ctx.reply('Voice features not configured. Set GROQ_API_KEY in .env.')
      return
    }

    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId)
      await ctx.reply('🔇 Voice mode off. Responses will be text only.')
    } else {
      voiceModeChats.add(chatId)
      const ttsNote = caps.tts
        ? 'Responses will be sent as voice messages (+ text).'
        : 'TTS not configured — responses will be text only.'
      await ctx.reply(`🔊 Voice mode on. ${ttsNote}`)
    }
  })

  bot.command('tasks', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(chatId)) return

    const allTasks = getAllTasks().filter((t) => t.chat_id === chatId)

    if (allTasks.length === 0) {
      await ctx.reply(
        '📭 No scheduled tasks yet.\n\nCreate one with:\n<code>/schedule create "prompt" "cron"</code>',
        { parse_mode: 'HTML' }
      )
      return
    }

    const lines = allTasks.map((t) => {
      const icon = t.status === 'active' ? '🟢' : '⏸️'
      const next = new Date(t.next_run).toLocaleString()
      const lastRun = t.last_run ? new Date(t.last_run).toLocaleString() : 'never'
      const result = t.last_result ? `\n      └ ${t.last_result.slice(0, 80)}` : ''
      return (
        `${icon} <code>${t.id}</code> · ${t.schedule}\n` +
        `   📌 ${t.prompt.slice(0, 60)}\n` +
        `   ⏭ Next: ${next}\n` +
        `   🕐 Last: ${lastRun}${result}`
      )
    })

    const header = `<b>📋 Scheduled Tasks (${allTasks.length})</b>\n`
    const footer = `\n\n<i>Manage: /schedule pause &lt;id&gt; · /schedule resume &lt;id&gt; · /schedule delete &lt;id&gt;</i>`
    await ctx.reply(header + lines.join('\n\n') + footer, { parse_mode: 'HTML' })
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
          // Try Parse: "prompt" "cron"
          const createMatch = rest.match(/"([^"]+)"\s+"([^"]+)"/)
          if (createMatch) {
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
          } else {
            // Fallback: Natural Language Parsing
            await ctx.api.sendChatAction(chatId, 'typing')
            const parsed = await parseScheduleNL(rest)
            if (!parsed) {
              await ctx.reply('Could not parse natural language schedule. Try:\n/schedule create "prompt" "cron expression"')
              return
            }
            try {
              const nextRun = computeNextRun(parsed.cron)
              const id = randomUUID().slice(0, 8)
              createTask({ id, chat_id: chatId, prompt: parsed.prompt, schedule: parsed.cron, next_run: nextRun, status: 'active' })
              await ctx.reply(
                `✅ <b>Scheduled task created from text</b>\n\n📌 ${parsed.prompt}\n⏰ Cron: <code>${parsed.cron}</code>\n⏭ Next run: ${new Date(nextRun).toLocaleString()}`,
                { parse_mode: 'HTML' }
              )
            } catch (err) {
              await ctx.reply(`Failed to create schedule. Generated cron: \`${parsed.cron}\``)
            }
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

      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true /* voiceReply */)
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
