import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ANSI colors
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}✗${RESET} ${msg}`)
const info = (msg: string) => console.log(`${CYAN}ℹ${RESET} ${msg}`)
const header = (msg: string) => console.log(`\n${BOLD}${msg}${RESET}\n`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(`${CYAN}?${RESET} ${q} `, resolve))

async function main() {
  console.log(`
${BOLD}╔══════════════════════════════════════╗
║       ClaudeClaw Setup Wizard        ║
╚══════════════════════════════════════╝${RESET}
`)

  // ── Step 1: Check requirements ───────────────────

  header('Checking requirements...')

  // Node version
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} — need >= 20`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const claudeVersion = execSync('claude --version 2>/dev/null', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    }).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    fail('Claude CLI not found. Install: https://docs.anthropic.com/en/claude-code')
    process.exit(1)
  }

  // npm install
  header('Installing dependencies...')
  try {
    const result = spawnSync('npm', ['install'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      fail('npm install failed')
      process.exit(1)
    }
    ok('Dependencies installed')
  } catch (err) {
    fail(`npm install failed: ${err}`)
    process.exit(1)
  }

  // Build
  header('Building project...')
  try {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      fail('Build failed')
      process.exit(1)
    }
    ok('Build succeeded')
  } catch (err) {
    fail(`Build failed: ${err}`)
    process.exit(1)
  }

  // ── Step 2: Collect config ───────────────────────

  header('Configuration')

  const envPath = resolve(PROJECT_ROOT, '.env')
  const envExamplePath = resolve(PROJECT_ROOT, '.env.example')
  const config: Record<string, string> = {}

  // Telegram bot token
  console.log(`\nTo create a Telegram bot:`)
  console.log(`  1. Open Telegram and search for @BotFather`)
  console.log(`  2. Send /newbot`)
  console.log(`  3. Choose a name and username`)
  console.log(`  4. Copy the token it gives you\n`)

  config['TELEGRAM_BOT_TOKEN'] = await ask('Telegram bot token:')
  if (!config['TELEGRAM_BOT_TOKEN']) {
    fail('Token is required')
    process.exit(1)
  }

  // Groq API key
  console.log(`\nFor voice transcription (Groq Whisper):`)
  console.log(`  Get a free API key at https://console.groq.com\n`)
  config['GROQ_API_KEY'] = await ask('Groq API key (Enter to skip):')

  // Google API key (optional, for video)
  config['GOOGLE_API_KEY'] = await ask('Google AI API key for video analysis (Enter to skip):')

  // WhatsApp
  const waChoice = await ask('Enable WhatsApp bridge? (y/N):')
  config['WHATSAPP_ENABLED'] = waChoice.toLowerCase() === 'y' ? 'true' : 'false'

  // Scheduler
  config['SCHEDULER_ENABLED'] = 'true'

  // Chat IDs — set empty initially
  config['ALLOWED_CHAT_IDS'] = ''

  config['LOG_LEVEL'] = 'info'
  config['NODE_ENV'] = 'development'

  // ── Step 3: Write .env ───────────────────────────

  header('Writing configuration...')

  const envContent = Object.entries(config)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(envPath, envContent + '\n')
  ok('.env written')

  // ── Step 4: Personalize CLAUDE.md ────────────────

  header('Personalizing CLAUDE.md')

  const claudeMdPath = resolve(PROJECT_ROOT, 'CLAUDE.md')
  const editor = process.env.EDITOR ?? 'nano'
  console.log(`\nOpening CLAUDE.md in ${editor}...`)
  console.log(`Fill in the [YOUR NAME] and [YOUR ASSISTANT NAME] placeholders.`)
  console.log(`Press any key when ready, or Enter to skip.\n`)

  const editChoice = await ask('Open in editor? (Y/n):')
  if (editChoice.toLowerCase() !== 'n') {
    try {
      spawnSync(editor, [claudeMdPath], { stdio: 'inherit' })
      ok('CLAUDE.md updated')
    } catch {
      warn(`Couldn't open editor. Edit ${claudeMdPath} manually.`)
    }
  } else {
    info(`Edit ${claudeMdPath} later to personalize your assistant.`)
  }

  // ── Step 5: Get chat ID ──────────────────────────

  header('Getting your chat ID')

  console.log(`\nI'll start the bot briefly so you can get your chat ID.`)
  console.log(`  1. Open your bot in Telegram`)
  console.log(`  2. Send /chatid`)
  console.log(`  3. Copy the number it replies with\n`)

  const chatId = await ask('Enter your Telegram chat ID (or press Enter to do later):')
  if (chatId) {
    // Update .env with chat ID
    const currentEnv = readFileSync(envPath, 'utf-8')
    writeFileSync(envPath, currentEnv.replace('ALLOWED_CHAT_IDS=', `ALLOWED_CHAT_IDS=${chatId}`))
    ok(`Chat ID ${chatId} saved`)
  } else {
    warn('Remember to set ALLOWED_CHAT_IDS in .env after sending /chatid to your bot')
  }

  // ── Step 6: Install background service ───────────

  header('Background service')

  const installService = await ask('Install as macOS background service (launchd)? (Y/n):')
  if (installService.toLowerCase() !== 'n') {
    installLaunchd()
  } else {
    info('Skipped service install. Run manually with: npm start')
  }

  // ── Done ─────────────────────────────────────────

  header('Setup complete! 🎉')

  console.log(`${BOLD}Next steps:${RESET}`)
  console.log(`  • Test:     npm run dev`)
  console.log(`  • Start:    npm run start`)
  console.log(`  • Status:   npm run status`)
  console.log(`  • Schedule: npm run schedule -- create "prompt" "cron" CHAT_ID`)
  console.log(``)
  console.log(`Send a message to your bot on Telegram to try it out!`)

  rl.close()
}

function installLaunchd(): void {
  const label = 'com.claudeclaw.app'
  const plistPath = resolve(
    process.env.HOME ?? '~',
    'Library',
    'LaunchAgents',
    `${label}.plist`
  )

  const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()
  const entryPoint = resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>`

  try {
    // Unload if already loaded
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`)
    } catch {
      // Not loaded, that's fine
    }

    writeFileSync(plistPath, plist)
    execSync(`launchctl load "${plistPath}"`)
    ok(`Service installed: ${plistPath}`)
    ok('ClaudeClaw will start on login and auto-restart if it crashes')
    info(`Logs: tail -f /tmp/claudeclaw.log`)
    info(`Stop: launchctl unload "${plistPath}"`)
  } catch (err) {
    fail(`Service install failed: ${err}`)
    warn('You can start manually with: npm start')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
