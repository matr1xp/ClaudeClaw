import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync, writeFileSync } from 'fs'
import { get } from 'https'
import { IncomingMessage } from 'http'
import { resolve, basename } from 'path'
import { UPLOADS_DIR, TELEGRAM_BOT_TOKEN } from './config.js'
import { logger } from './logger.js'

// Ensure uploads directory exists
mkdirSync(UPLOADS_DIR, { recursive: true })

/**
 * Download a file from Telegram servers to local disk.
 */
export async function downloadMedia(
  fileId: string,
  originalFilename?: string
): Promise<string> {
  mkdirSync(UPLOADS_DIR, { recursive: true })

  // Step 1: Get file path from Telegram API
  const fileInfo = await fetchJson<TelegramFileResponse>(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  )

  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error(`Failed to get file info: ${JSON.stringify(fileInfo)}`)
  }

  const remotePath = fileInfo.result.file_path as string

  // Step 2: Download the file
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${remotePath}`
  const ext = remotePath.includes('.') ? remotePath.slice(remotePath.lastIndexOf('.')) : ''
  const safeName = sanitizeFilename(originalFilename ?? basename(remotePath))
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  const buffer = await downloadBuffer(url)
  writeFileSync(localPath, buffer)

  logger.info({ localPath, size: buffer.length }, 'Media downloaded')
  return localPath
}

/**
 * Build a prompt message for a photo that Claude can analyze.
 */
export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo received, saved to: ${localPath}]`]
  parts.push(`Please analyze the image at the path above.`)
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

/**
 * Build a prompt message for a document.
 */
export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string
): string {
  const parts = [`[Document received: ${filename}, saved to: ${localPath}]`]
  parts.push(`Please read and analyze the document at the path above.`)
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

/**
 * Build a prompt message for a video.
 */
export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [`[Video received, saved to: ${localPath}]`]
  parts.push(
    `Please analyze this video. You can use the Gemini API with the GOOGLE_API_KEY from the .env file to analyze it if needed.`
  )
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

/**
 * Clean up old uploaded files.
 */
export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  if (!existsSync(UPLOADS_DIR)) return

  const now = Date.now()
  let cleaned = 0

  for (const file of readdirSync(UPLOADS_DIR)) {
    const filePath = resolve(UPLOADS_DIR, file)
    try {
      const stat = statSync(filePath)
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath)
        cleaned++
      }
    } catch {
      // Ignore errors on individual files
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up old uploads')
  }
}

// ── Helpers ────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

interface TelegramFileResponse {
  ok: boolean
  result?: {
    file_path?: string
  }
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    get(url, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch (err) {
          reject(err)
        }
      })
    }).on('error', reject)
  })
}

function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    get(url, (res: IncomingMessage) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}
