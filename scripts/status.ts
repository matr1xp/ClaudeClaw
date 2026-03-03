import { execSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ANSI
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (label: string, value: string) =>
  console.log(`  ${GREEN}✓${RESET} ${label}: ${value}`)
const warn = (label: string, value: string) =>
  console.log(`  ${YELLOW}⚠${RESET} ${label}: ${value}`)
const fail = (label: string, value: string) =>
  console.log(`  ${RED}✗${RESET} ${label}: ${value}`)

function readEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    env[trimmed.slice(0, eq).trim()] = val
  }
  return env
}

function main(): void {
  console.log(`\n${BOLD}ClaudeClaw Status${RESET}\n`)

  // Node
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  if (major >= 20) {
    ok('Node.js', nodeVersion)
  } else {
    fail('Node.js', `${nodeVersion} (need >=20)`)
  }

  // Claude CLI
  try {
    const v = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    ok('Claude CLI', v)
  } catch {
    fail('Claude CLI', 'not found')
  }

  // .env
  const env = readEnv()
  if (Object.keys(env).length > 0) {
    ok('.env', 'found')
  } else {
    fail('.env', 'missing or empty')
  }

  // Bot token
  if (env['TELEGRAM_BOT_TOKEN']) {
    ok('Bot token', 'configured')
  } else {
    fail('Bot token', 'not set')
  }

  // Chat IDs
  const chatIds = env['ALLOWED_CHAT_IDS']
  if (chatIds) {
    ok('Allowed chats', chatIds)
  } else {
    warn('Allowed chats', 'not set (open access mode)')
  }

  // Groq
  if (env['GROQ_API_KEY']) {
    ok('Groq STT', 'configured')
  } else {
    warn('Groq STT', 'not set')
  }

  // WhatsApp
  if (env['WHATSAPP_ENABLED'] === 'true') {
    ok('WhatsApp', 'enabled')
  } else {
    warn('WhatsApp', 'disabled')
  }

  // Database
  const dbPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.db')
  if (existsSync(dbPath)) {
    const size = statSync(dbPath).size
    ok('Database', `${(size / 1024).toFixed(1)} KB`)
  } else {
    warn('Database', 'not created yet (starts on first run)')
  }

  // Service
  const plistLabel = 'com.claudeclaw.app'
  try {
    const list = execSync(`launchctl list 2>/dev/null`, { encoding: 'utf-8' })
    if (list.includes(plistLabel)) {
      ok('Service', 'running (launchd)')
    } else {
      warn('Service', 'not loaded')
    }
  } catch {
    warn('Service', 'unable to check')
  }

  // PID
  const pidPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.pid')
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim()
    try {
      process.kill(parseInt(pid, 10), 0)
      ok('Process', `running (PID ${pid})`)
    } catch {
      warn('Process', `stale PID file (${pid})`)
    }
  } else {
    warn('Process', 'not running')
  }

  // Build
  const distPath = resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')
  if (existsSync(distPath)) {
    ok('Build', 'dist/src/index.js exists')
  } else {
    fail('Build', 'not built (run: npm run build)')
  }

  console.log('')
}

main()
