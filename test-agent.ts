import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function runTest() {
  console.log('Starting test agent...')
  try {
    const conversation = query({
      prompt: 'Hello world!',
      options: {
        cwd: resolve(__dirname),
        permissionMode: 'bypassPermissions',
        env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', DEBUG_CLAUDE_AGENT_SDK: '1' },
      }
    })

    for await (const event of conversation) {
      if (event.type === 'result') {
        if ('result' in event && typeof event.result === 'string') {
          console.log('Agent Result:', event.result)
        }
      }
    }
  } catch (err: any) {
    console.error('Agent Error:', err)
    if (err.stdout) console.error('STDOUT:', err.stdout)
    if (err.stderr) console.error('STDERR:', err.stderr)
  }
}

runTest()
