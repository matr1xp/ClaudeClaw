import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, updateTaskAfterRun } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { SCHEDULER_POLL_MS } from './config.js'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

/**
 * Initialize the scheduler polling loop.
 */
export function initScheduler(send: Sender): void {
  sender = send
  pollInterval = setInterval(runDueTasks, SCHEDULER_POLL_MS)
  logger.info({ intervalMs: SCHEDULER_POLL_MS }, 'Scheduler started')
  // Run immediately on startup
  runDueTasks().catch((err) => logger.error({ err }, 'Initial scheduler run failed'))
}

/**
 * Check for and execute any due scheduled tasks.
 */
export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due tasks')

  for (const task of tasks) {
    try {
      // Notify start
      if (sender) {
        await sender(task.chat_id, `⏰ Running scheduled task: ${task.prompt.slice(0, 100)}...`)
      }

      // Run autonomously (no session, no typing)
      const result = await runAgent(task.prompt)
      const responseText = result.text ?? 'Task completed (no output)'

      // Compute next run
      const nextRun = computeNextRun(task.schedule)

      // Update DB
      updateTaskAfterRun(task.id, nextRun, responseText.slice(0, 5000))

      // Send result
      if (sender) {
        await sender(task.chat_id, `📋 Scheduled task result:\n\n${responseText}`)
      }

      logger.info({ taskId: task.id, nextRun: new Date(nextRun).toISOString() }, 'Task completed')
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed')
      if (sender) {
        await sender(
          task.chat_id,
          `❌ Scheduled task failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}

/**
 * Compute the next run time from a cron expression.
 */
export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression)
  return expr.next().getTime()
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    logger.info('Scheduler stopped')
  }
}
