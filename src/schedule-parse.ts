import { runAgent } from './agent.js'
import { logger } from './logger.js'

/**
 * Regex pre-screen for scheduling intent.
 * Fast check to avoid unnecessary agent calls on regular messages.
 */
const SCHEDULE_INTENT_PATTERN =
  /\b(every\s+(day|morning|evening|night|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|week|month)|daily\s+at|weekly\s+on|remind\s+me\s+(to|every|at|on)|schedule\s+(a|me|this)|at\s+\d{1,2}[:.]\d{2}\s*(am|pm)?\s+(every|daily|each)|recurring|repeating|automatically\s+(check|send|run|do)|cron)/i

/**
 * Check whether a message likely contains a scheduling intent.
 */
export function hasScheduleIntent(text: string): boolean {
  return SCHEDULE_INTENT_PATTERN.test(text)
}

/**
 * Use the Claude agent to parse a natural-language scheduling request
 * into a task prompt and cron expression.
 *
 * Returns null if the text cannot be parsed as a schedule.
 */
export async function parseScheduleNL(
  text: string
): Promise<{ prompt: string; cron: string } | null> {
  const systemPrompt = `You are a scheduling parser. Given a user request, extract:
1. "prompt" — the task to perform (what to do), without time/frequency words
2. "cron" — a standard 5-field cron expression (minute hour day-of-month month day-of-week)

Respond with ONLY a JSON object on a single line, no markdown, no explanation:
{"prompt": "...", "cron": "..."}

If the input is NOT a scheduling request, respond with exactly: null

Examples:
- "Check my Gmail every day at 7:00 AM" → {"prompt": "Check my Gmail emails and list unread", "cron": "0 7 * * *"}
- "Every weekday at 9am send me a weather report" → {"prompt": "Send me a weather report", "cron": "0 9 * * 1-5"}
- "Remind me to check stocks every Monday at 8:30" → {"prompt": "Check stocks", "cron": "30 8 * * 1"}
- "What is the weather today?" → null`

  try {
    const result = await runAgent(`${systemPrompt}\n\nUser input: "${text}"`)
    const raw = (result.text ?? '').trim()

    if (raw === 'null' || !raw.startsWith('{')) {
      return null
    }

    // Extract JSON — handle potential markdown wrapping
    const jsonMatch = raw.match(/\{[^}]+\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    if (
      typeof parsed.prompt === 'string' &&
      typeof parsed.cron === 'string' &&
      parsed.prompt.length > 0 &&
      parsed.cron.length > 0
    ) {
      return { prompt: parsed.prompt, cron: parsed.cron }
    }

    return null
  } catch (err) {
    logger.error({ err }, 'Failed to parse schedule from natural language')
    return null
  }
}
