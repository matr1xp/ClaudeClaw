import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, TYPING_REFRESH_MS } from './config.js'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'

export interface AgentResult {
  text: string | null
  newSessionId?: string
}

/**
 * Run a message through the Claude Code SDK.
 * Spawns the real `claude` CLI subprocess with session resumption.
 */
export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<AgentResult> {
  let newSessionId: string | undefined
  let resultText: string | null = null

  // Refresh typing indicator while waiting
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  try {
    const fileEnv = readEnvFile()
    const customModel = fileEnv.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL

    const conversation = query({
      prompt: message,
      options: {
        cwd: PROJECT_ROOT,
        permissionMode: 'bypassPermissions',
        ...(customModel ? { model: customModel } : {}),
        env: { 
            ...process.env, 
            ...fileEnv, 
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' 
        },
        ...(sessionId ? { resume: sessionId } : {}),
        settingSources: ['project', 'user'],
      },
    })

    for await (const event of conversation) {
      if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
        // Extract session ID from init event
        if ('sessionId' in event && typeof event.sessionId === 'string') {
          newSessionId = event.sessionId
        }
      }

      if (event.type === 'result') {
        if ('result' in event && typeof event.result === 'string') {
          resultText = event.result
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Agent error')
    if (err instanceof Error && 'stdout' in err) {
      logger.error({ stdout: (err as any).stdout, stderr: (err as any).stderr }, 'Agent process output')
    }
    resultText = `Error running agent: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId }
}
