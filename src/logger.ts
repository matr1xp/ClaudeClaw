import pino from 'pino'
import { appendFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { STORE_DIR } from './config.js'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

const ERROR_LOG_PATH = resolve(STORE_DIR, 'errors.log')

mkdirSync(STORE_DIR, { recursive: true })

interface ErrorContext {
  chatId?: string
  command?: string
  sessionId?: string
  [key: string]: unknown
}

function formatErrorLog(err: unknown, context?: ErrorContext): string {
  const timestamp = new Date().toISOString()
  const errorObj = err instanceof Error ? err : new Error(String(err))

  const lines: string[] = []
  lines.push(`\n${'='.repeat(80)}`)
  lines.push(`ERROR at ${timestamp}`)
  lines.push(`${'-'.repeat(80)}`)
  lines.push(`Message: ${errorObj.message}`)
  lines.push(`Type: ${err?.constructor?.name || 'Error'}`)

  if (context && Object.keys(context).length > 0) {
    lines.push(`${'-'.repeat(80)}`)
    lines.push('Context:')
    for (const [key, value] of Object.entries(context)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`)
    }
  }

  if (errorObj.stack) {
    lines.push(`${'-'.repeat(80)}`)
    lines.push('Stack trace:')
    lines.push(errorObj.stack)
  }

  if (err && typeof err === 'object') {
    const extraProps = Object.entries(err).filter(
      ([key]) => !['message', 'stack', 'name'].includes(key)
    )
    if (extraProps.length > 0) {
      lines.push(`${'-'.repeat(80)}`)
      lines.push('Additional properties:')
      for (const [key, value] of extraProps) {
        try {
          lines.push(`  ${key}: ${JSON.stringify(value)}`)
        } catch {
          lines.push(`  ${key}: [unserializable]`)
        }
      }
    }
  }

  lines.push(`${'='.repeat(80)}\n`)
  return lines.join('\n')
}

export function logError(err: unknown, context?: ErrorContext): void {
  const logEntry = formatErrorLog(err, context)

  try {
    appendFileSync(ERROR_LOG_PATH, logEntry, 'utf-8')
  } catch (writeErr) {
    logger.error({ err: writeErr }, 'Failed to write to error log file')
  }

  logger.error({ err, ...context }, 'Error captured')
}

export function logErrorWithMessage(message: string, err: unknown, context?: ErrorContext): void {
  const fullContext = { ...context, message }
  logError(err, fullContext)
}

export function getErrorLogPath(): string {
  return ERROR_LOG_PATH
}
