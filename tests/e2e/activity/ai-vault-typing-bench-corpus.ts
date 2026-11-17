import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type SeededVaultBatch = {
  newestTitle: string
  totalBytes: number
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value)
}

export function seedVaultTranscriptBatch(args: {
  homePath: string
  cwd: string
  batch: number
  sessionCount: number
  payloadBytes: number
}): SeededVaultBatch {
  const sessionsDir = path.join(args.homePath, '.codex', 'sessions', '2026', '08', '09')
  mkdirSync(sessionsDir, { recursive: true })
  const padding = 'x'.repeat(args.payloadBytes)
  const baseTimeMs = Date.now() + args.batch * 10_000
  let totalBytes = 0
  let newestTitle = ''

  for (let index = 0; index < args.sessionCount; index += 1) {
    const sessionId = `vault-bench-${args.batch}-${index}`
    const title = `Vault benchmark batch ${args.batch} session ${index}`
    const timestamp = new Date(baseTimeMs + index).toISOString()
    const content = `${[
      jsonLine({
        timestamp,
        type: 'session_meta',
        payload: { id: sessionId, cwd: args.cwd }
      }),
      jsonLine({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: title }]
        }
      }),
      jsonLine({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: padding }]
        }
      })
    ].join('\n')}\n`
    const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`)
    writeFileSync(filePath, content)
    const mtime = new Date(baseTimeMs + index)
    utimesSync(filePath, mtime, mtime)
    totalBytes += Buffer.byteLength(content)
    newestTitle = title
  }

  return { newestTitle, totalBytes }
}

export function typingEchoScript(readyMarker: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let input = ''
const interrupt = String.fromCharCode(3)
process.stdout.write('\\x1b[2J\\x1b[H${readyMarker}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) process.exit(0)
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    input += char
  }
  process.stdout.write('\\r\\x1b[2K' + input)
})
`
}
