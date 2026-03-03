import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// In dev: src/env.ts -> project root is ..
// In prod: dist/src/env.js -> project root is ../..
const isCompiled = __dirname.includes('/dist/') || __dirname.includes('\\dist\\')
const PROJECT_ROOT = resolve(__dirname, isCompiled ? '../..' : '..')

/**
 * Parse a .env file without polluting process.env.
 * Handles quoted values and comments.
 */
export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue

    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (keys && !keys.includes(key)) continue
    result[key] = value
  }

  return result
}
