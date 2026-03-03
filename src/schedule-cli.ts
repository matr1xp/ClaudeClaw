import { randomUUID } from 'crypto'
import { CronExpressionParser } from 'cron-parser'
import {
  initDatabase,
  createTask,
  getAllTasks,
  getTask,
  deleteTask,
  pauseTask,
  resumeTask,
} from './db.js'

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`
ClaudeClaw Scheduler CLI

Usage:
  schedule-cli create "<prompt>" "<cron>" <chat_id>
  schedule-cli list
  schedule-cli delete <task_id>
  schedule-cli pause <task_id>
  schedule-cli resume <task_id>

Cron Examples:
  "0 9 * * *"      — Every day at 9am
  "0 9 * * 1"      — Every Monday at 9am
  "0 */4 * * *"    — Every 4 hours
  "*/30 * * * *"   — Every 30 minutes
`)
}

function main(): void {
  initDatabase()

  switch (command) {
    case 'create': {
      const prompt = args[1]
      const cron = args[2]
      const chatId = args[3]

      if (!prompt || !cron || !chatId) {
        console.error('Missing arguments. Usage: create "<prompt>" "<cron>" <chat_id>')
        process.exit(1)
      }

      // Validate cron
      try {
        CronExpressionParser.parse(cron)
      } catch (err) {
        console.error(`Invalid cron expression: ${cron}`)
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }

      const id = randomUUID().slice(0, 8)
      const nextRun = CronExpressionParser.parse(cron).next().getTime()

      createTask({ id, chat_id: chatId, prompt, schedule: cron, next_run: nextRun, status: 'active' })
      console.log(`✓ Task created: ${id}`)
      console.log(`  Prompt: ${prompt}`)
      console.log(`  Schedule: ${cron}`)
      console.log(`  Next run: ${new Date(nextRun).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        return
      }

      console.log('\nScheduled Tasks:')
      console.log('─'.repeat(80))
      for (const t of tasks) {
        const nextStr = new Date(t.next_run).toLocaleString()
        const status = t.status === 'active' ? '🟢' : '⏸️'
        console.log(`${status} [${t.id}] ${t.prompt.slice(0, 50)}`)
        console.log(`   Schedule: ${t.schedule} | Next: ${nextStr} | Chat: ${t.chat_id}`)
        if (t.last_run) {
          console.log(`   Last run: ${new Date(t.last_run).toLocaleString()}`)
        }
        console.log('')
      }
      break
    }

    case 'delete': {
      const id = args[1]
      if (!id) {
        console.error('Usage: delete <task_id>')
        process.exit(1)
      }
      if (deleteTask(id)) {
        console.log(`✓ Task ${id} deleted`)
      } else {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      break
    }

    case 'pause': {
      const id = args[1]
      if (!id) {
        console.error('Usage: pause <task_id>')
        process.exit(1)
      }
      if (pauseTask(id)) {
        console.log(`✓ Task ${id} paused`)
      } else {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      break
    }

    case 'resume': {
      const id = args[1]
      if (!id) {
        console.error('Usage: resume <task_id>')
        process.exit(1)
      }
      const task = getTask(id)
      if (!task) {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      const nextRun = CronExpressionParser.parse(task.schedule).next().getTime()
      if (resumeTask(id, nextRun)) {
        console.log(`✓ Task ${id} resumed`)
        console.log(`  Next run: ${new Date(nextRun).toLocaleString()}`)
      } else {
        console.error(`Failed to resume task ${id}`)
        process.exit(1)
      }
      break
    }

    default:
      usage()
      break
  }
}

main()
