import {
  saveMemory,
  searchMemories,
  getRecentMemories,
  touchMemory,
  decayAllMemories,
  type Memory,
} from './db.js'
import { logger } from './logger.js'

const SEMANTIC_PATTERN =
  /\b(my|i am|i'm|i prefer|remember|always|never|i use|i like|i hate|i need|i want|i work|i live)\b/i

/**
 * Build memory context to inject before the user's message.
 * Combines FTS5 search results with recent memories, deduped.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string
): Promise<string> {
  try {
    // FTS5 search
    const searchResults = searchMemories(chatId, userMessage, 3)

    // Recent memories
    const recent = getRecentMemories(chatId, 5)

    // Deduplicate by id
    const seen = new Set<number>()
    const all: Memory[] = []

    for (const m of [...searchResults, ...recent]) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        all.push(m)
      }
    }

    if (all.length === 0) return ''

    // Touch each accessed memory (reinforce salience)
    for (const m of all) {
      touchMemory(m.id)
    }

    const lines = all.map(
      (m) => `- ${m.content} (${m.sector}, salience: ${m.salience.toFixed(2)})`
    )

    return `[Memory context]\n${lines.join('\n')}\n`
  } catch (err) {
    logger.error({ err }, 'Failed to build memory context')
    return ''
  }
}

/**
 * Save a conversation exchange as a memory.
 * Detects semantic signals to classify the memory sector.
 */
export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  try {
    // Skip very short messages or commands
    if (userMsg.length <= 20 || userMsg.startsWith('/')) return

    const isSemantic = SEMANTIC_PATTERN.test(userMsg)
    const sector = isSemantic ? 'semantic' : 'episodic'

    // Save user message as memory
    const content = `User: ${userMsg.slice(0, 500)}`
    saveMemory(chatId, content, sector)

    // Save a compact version of assistant response if substantial
    if (assistantMsg.length > 50) {
      const summary = `Assistant: ${assistantMsg.slice(0, 300)}`
      saveMemory(chatId, summary, 'episodic')
    }
  } catch (err) {
    logger.error({ err }, 'Failed to save conversation turn')
  }
}

/**
 * Decay old memories and delete low-salience ones.
 * Should be called once per day.
 */
export function runDecaySweep(): void {
  try {
    const result = decayAllMemories()
    logger.info(
      { decayed: result.decayed, deleted: result.deleted },
      'Memory decay sweep complete'
    )
  } catch (err) {
    logger.error({ err }, 'Memory decay sweep failed')
  }
}
