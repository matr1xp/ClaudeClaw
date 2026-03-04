import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    db = new Database(`${STORE_DIR}/claudeclaw.db`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

// ── Schema ─────────────────────────────────────────────

export function initDatabase(): void {
  const d = getDb()

  // Sessions — one per chat, stores Claude Code session ID
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Memories — dual-sector with salience decay
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_chat
      ON memories (chat_id, sector, salience DESC)
  `)

  // FTS5 virtual table for full-text memory search
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, content_rowid=id)
  `)

  // FTS sync triggers
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  // Scheduled tasks
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_due
      ON scheduled_tasks (status, next_run)
  `)

  // WhatsApp outbox — messages queued to send
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
      created_at INTEGER NOT NULL
    )
  `)

  // WhatsApp messages cache
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0
    )
  `)

  // WhatsApp chat ↔ Telegram chat mapping
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_message_map (
      telegram_chat_id TEXT NOT NULL,
      wa_chat_jid TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id)
    )
  `)

  logger.info('Database initialized')
}

// ── Sessions ───────────────────────────────────────────

export function getSession(chatId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined
  return row?.session_id
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at`
    )
    .run(chatId, sessionId, Date.now())
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// ── Memories ───────────────────────────────────────────

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
       VALUES (?, ?, ?, ?, 1.0, ?, ?)`
    )
    .run(chatId, topicKey ?? null, content, sector, now, now)
}

export function searchMemories(
  chatId: string,
  query: string,
  limit = 3
): Memory[] {
  // Sanitize for FTS5: strip non-alphanumeric, add prefix matching
  const sanitized = query
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(' ')

  if (!sanitized) return []

  return getDb()
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON f.rowid = m.id
       WHERE f.content MATCH ? AND m.chat_id = ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(sanitized, chatId, limit) as Memory[]
}

export function getRecentMemories(chatId: string, limit = 5): Memory[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, limit) as Memory[]
}

export function getHighSalienceMemories(
  chatId: string,
  minSalience = 3.0,
  limit = 5
): Memory[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ? AND salience >= ?
       ORDER BY salience DESC, accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, minSalience, limit) as Memory[]
}

export function touchMemory(id: number): void {
  getDb()
    .prepare(
      `UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?`
    )
    .run(Date.now(), id)
}

export function decayAllMemories(): { decayed: number; deleted: number } {
  const oneDayAgo = Date.now() - 86_400_000
  const d = getDb()

  const decayResult = d
    .prepare(
      `UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?`
    )
    .run(oneDayAgo)

  const deleteResult = d
    .prepare(`DELETE FROM memories WHERE salience < 0.1`)
    .run()

  return {
    decayed: decayResult.changes,
    deleted: deleteResult.changes,
  }
}

export function getMemoriesForChat(
  chatId: string,
  limit = 20
): Memory[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? ORDER BY salience DESC, accessed_at DESC LIMIT ?`
    )
    .all(chatId, limit) as Memory[]
}

export function deleteAllMemories(chatId: string): void {
  getDb().prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
}

// ── Scheduled Tasks ────────────────────────────────────

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'created_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(task.id, task.chat_id, task.prompt, task.schedule, task.next_run, task.status, Date.now())
}

export function getDueTasks(): ScheduledTask[] {
  const now = Date.now()
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?`
    )
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string
): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?`
    )
    .run(Date.now(), result, nextRun, id)
}

export function getAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function getTask(id: string): ScheduledTask | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined
}

export function deleteTask(id: string): boolean {
  return getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
    .changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    getDb()
      .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?")
      .run(id).changes > 0
  )
}

export function resumeTask(id: string, nextRun: number): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE scheduled_tasks SET status = 'active', next_run = ? WHERE id = ?"
      )
      .run(nextRun, id).changes > 0
  )
}

// ── WhatsApp ───────────────────────────────────────────

export function queueWaMessage(chatJid: string, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO wa_outbox (chat_jid, content, status, created_at) VALUES (?, ?, 'pending', ?)`
    )
    .run(chatJid, content, Date.now())
}

export function getPendingWaMessages(): Array<{
  id: number
  chat_jid: string
  content: string
}> {
  return getDb()
    .prepare(
      "SELECT id, chat_jid, content FROM wa_outbox WHERE status = 'pending' ORDER BY created_at"
    )
    .all() as Array<{ id: number; chat_jid: string; content: string }>
}

export function markWaMessageSent(id: number): void {
  getDb()
    .prepare("UPDATE wa_outbox SET status = 'sent' WHERE id = ?")
    .run(id)
}

export function markWaMessageFailed(id: number): void {
  getDb()
    .prepare("UPDATE wa_outbox SET status = 'failed' WHERE id = ?")
    .run(id)
}

export function saveWaMessage(msg: {
  id: string
  chatJid: string
  sender: string
  content: string
  timestamp: number
  isFromMe: boolean
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO wa_messages (id, chat_jid, sender, content, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(msg.id, msg.chatJid, msg.sender, msg.content, msg.timestamp, msg.isFromMe ? 1 : 0)
}

export function getWaMessages(
  chatJid: string,
  limit = 20
): Array<{
  id: string
  sender: string
  content: string
  timestamp: number
  is_from_me: number
}> {
  return getDb()
    .prepare(
      `SELECT id, sender, content, timestamp, is_from_me
       FROM wa_messages WHERE chat_jid = ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(chatJid, limit) as Array<{
    id: string
    sender: string
    content: string
    timestamp: number
    is_from_me: number
  }>
}

export function setWaChatMap(
  telegramChatId: string,
  waChatJid: string
): void {
  getDb()
    .prepare(
      `INSERT INTO wa_message_map (telegram_chat_id, wa_chat_jid, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_chat_id) DO UPDATE SET wa_chat_jid=excluded.wa_chat_jid, updated_at=excluded.updated_at`
    )
    .run(telegramChatId, waChatJid, Date.now())
}

export function getWaChatMap(
  telegramChatId: string
): string | undefined {
  const row = getDb()
    .prepare(
      'SELECT wa_chat_jid FROM wa_message_map WHERE telegram_chat_id = ?'
    )
    .get(telegramChatId) as { wa_chat_jid: string } | undefined
  return row?.wa_chat_jid
}

// ── WAL Checkpoint ─────────────────────────────────────

const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
let walCheckpointTimer: ReturnType<typeof setInterval> | undefined

export function walCheckpoint(): void {
  try {
    const d = getDb()
    d.pragma('wal_checkpoint(TRUNCATE)')
    logger.info('WAL checkpoint completed')
  } catch (err) {
    logger.error({ err }, 'WAL checkpoint failed')
  }
}

export function startWalCheckpoints(): void {
  // Run once immediately
  walCheckpoint()
  // Then every hour
  walCheckpointTimer = setInterval(walCheckpoint, WAL_CHECKPOINT_INTERVAL_MS)
}

export function closeDatabase(): void {
  if (walCheckpointTimer) {
    clearInterval(walCheckpointTimer)
    walCheckpointTimer = undefined
  }
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  }
}
