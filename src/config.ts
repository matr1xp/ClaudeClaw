import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Paths ──────────────────────────────────────────────
export const PROJECT_ROOT = resolve(__dirname, '..')
export const STORE_DIR = resolve(PROJECT_ROOT, 'store')
export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads')

// ── Env ────────────────────────────────────────────────
const env = readEnvFile()

// ── Telegram ───────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_IDS = (env['ALLOWED_CHAT_IDS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ── Voice — Groq STT ──────────────────────────────────
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''

// ── WhatsApp ───────────────────────────────────────────
export const WHATSAPP_ENABLED = (env['WHATSAPP_ENABLED'] ?? 'false') === 'true'

// ── Scheduler ──────────────────────────────────────────
export const SCHEDULER_ENABLED =
  (env['SCHEDULER_ENABLED'] ?? 'true') === 'true'

// ── Constants ──────────────────────────────────────────
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
export const SCHEDULER_POLL_MS = 60_000
export const MEMORY_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h
