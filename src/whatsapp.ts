import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import qrcode from 'qrcode-terminal'
import {
  queueWaMessage,
  getPendingWaMessages,
  markWaMessageSent,
  markWaMessageFailed,
  saveWaMessage,
  getWaMessages,
  setWaChatMap,
  getWaChatMap,
} from './db.js'
import { logger } from './logger.js'
import { STORE_DIR } from './config.js'

type IncomingHandler = (chatJid: string, sender: string, content: string) => Promise<void>

let client: InstanceType<typeof Client> | null = null
let onIncoming: IncomingHandler | null = null
let outboxInterval: ReturnType<typeof setInterval> | null = null
let isReady = false

/**
 * Initialize the WhatsApp bridge.
 * Shows QR code on first run for authentication.
 */
export function initWhatsApp(incomingHandler: IncomingHandler): void {
  onIncoming = incomingHandler

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: `${STORE_DIR}/wa-session` }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })

  client.on('qr', (qr: string) => {
    logger.info('WhatsApp QR code — scan with your phone:')
    qrcode.generate(qr, { small: true })
  })

  client.on('ready', () => {
    isReady = true
    logger.info('WhatsApp client ready')

    // Start outbox polling
    outboxInterval = setInterval(processOutbox, 5000)
  })

  client.on('message', async (msg: any) => {
    try {
      const chatId = msg.from
      const sender = msg._data?.notifyName ?? msg.from
      const content = msg.body

      if (!content) return

      // Save to DB
      saveWaMessage({
        id: msg.id._serialized,
        chatJid: chatId,
        sender,
        content,
        timestamp: msg.timestamp * 1000,
        isFromMe: false,
      })

      // Forward to Telegram
      if (onIncoming) {
        await onIncoming(chatId, sender, content)
      }
    } catch (err) {
      logger.error({ err }, 'Error handling WhatsApp message')
    }
  })

  client.on('disconnected', (reason: string) => {
    isReady = false
    logger.warn({ reason }, 'WhatsApp disconnected')
  })

  client.initialize().catch((err: Error) => {
    logger.error({ err }, 'WhatsApp initialization failed')
  })
}

/**
 * Process pending outbox messages.
 */
async function processOutbox(): Promise<void> {
  if (!client || !isReady) return

  const pending = getPendingWaMessages()
  for (const msg of pending) {
    try {
      await client.sendMessage(msg.chat_jid, msg.content)
      markWaMessageSent(msg.id)
      logger.info({ chatJid: msg.chat_jid }, 'WhatsApp message sent')
    } catch (err) {
      markWaMessageFailed(msg.id)
      logger.error({ err, id: msg.id }, 'Failed to send WhatsApp message')
    }
  }
}

/**
 * Send a message to a WhatsApp chat (queues in outbox).
 */
export function sendWaMessage(chatJid: string, content: string): void {
  queueWaMessage(chatJid, content)
}

/**
 * Get recent chats from WhatsApp.
 */
export async function getRecentChats(limit = 10): Promise<
  Array<{ id: string; name: string; lastMessage: string; timestamp: number }>
> {
  if (!client || !isReady) return []

  try {
    const chats = await client.getChats()
    return chats.slice(0, limit).map((chat: any) => ({
      id: chat.id._serialized,
      name: chat.name,
      lastMessage: (chat.lastMessage?.body ?? '').slice(0, 100),
      timestamp: chat.lastMessage?.timestamp ? chat.lastMessage.timestamp * 1000 : 0,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get WhatsApp chats')
    return []
  }
}

/**
 * Get messages from a specific WhatsApp chat.
 */
export function getWaChatMessages(chatJid: string, limit = 20) {
  return getWaMessages(chatJid, limit)
}

/**
 * Map a Telegram chat to a WhatsApp chat.
 */
export function mapTelegramToWa(telegramChatId: string, waChatJid: string): void {
  setWaChatMap(telegramChatId, waChatJid)
}

/**
 * Get the WhatsApp chat mapped to a Telegram chat.
 */
export function getMappedWaChat(telegramChatId: string): string | undefined {
  return getWaChatMap(telegramChatId)
}

export function isWhatsAppReady(): boolean {
  return isReady
}

export function stopWhatsApp(): void {
  if (outboxInterval) {
    clearInterval(outboxInterval)
    outboxInterval = null
  }
  if (client) {
    client.destroy()
    client = null
    isReady = false
  }
  logger.info('WhatsApp stopped')
}
