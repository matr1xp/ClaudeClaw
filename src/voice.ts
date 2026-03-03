import { readFileSync, renameSync, existsSync } from 'fs'
import { request } from 'https'
import { basename, extname } from 'path'
import { GROQ_API_KEY } from './config.js'
import { logger } from './logger.js'

/**
 * Transcribe an audio file using Groq Whisper API.
 * Handles the OGA → OGG rename that Groq requires.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured')
  }

  // Groq won't accept .oga — rename to .ogg (same codec)
  let finalPath = filePath
  if (extname(filePath).toLowerCase() === '.oga') {
    finalPath = filePath.replace(/\.oga$/i, '.ogg')
    renameSync(filePath, finalPath)
  }

  const fileBuffer = readFileSync(finalPath)
  const filename = basename(finalPath)
  const boundary = `----FormBoundary${Date.now()}`

  // Build multipart/form-data manually (no extra deps)
  const parts: Buffer[] = []

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    )
  )
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n'))

  // Model part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`
    )
  )

  // Close
  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res: any) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          try {
            const json = JSON.parse(raw)
            if (json.text) {
              resolve(json.text)
            } else if (json.error) {
              reject(new Error(`Groq API error: ${json.error.message ?? raw}`))
            } else {
              reject(new Error(`Unexpected Groq response: ${raw}`))
            }
          } catch {
            reject(new Error(`Failed to parse Groq response: ${raw}`))
          }
        })
      }
    )

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Check if STT capabilities are available.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!GROQ_API_KEY,
    tts: false, // TTS not enabled in this build
  }
}
