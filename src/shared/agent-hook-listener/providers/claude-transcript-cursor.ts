import { open, type FileHandle } from 'node:fs/promises'

const CHUNK_BYTES = 1024 * 1024
const LINE_BYTES = 256 * 1024

export type ClaudeTranscriptCursor = {
  path: string
  offset: number
  identity?: string
  carry: Buffer
  skipping: boolean
}

export function createClaudeTranscriptCursor(path: string): ClaudeTranscriptCursor {
  return { path, offset: 0, carry: Buffer.alloc(0), skipping: false }
}

/** Forward progress never drops older terminal evidence to catch up with a growing transcript. */
export async function readClaudeTranscriptChunk(
  cursor: ClaudeTranscriptCursor,
  limit = CHUNK_BYTES
) {
  let file: FileHandle | undefined
  try {
    file = await open(cursor.path, 'r')
    const stats = await file.stat()
    if (!stats.isFile()) {
      return undefined
    }
    let reset = false
    const identity = `${stats.dev}:${stats.ino}`
    if (
      (cursor.identity !== undefined && cursor.identity !== identity) ||
      stats.size < cursor.offset
    ) {
      reset = true
      cursor.offset = stats.size
      cursor.carry = Buffer.alloc(0)
      cursor.skipping = false
    }
    cursor.identity = identity
    const bytes = Buffer.alloc(Math.min(limit, Math.max(0, stats.size - cursor.offset)))
    const { bytesRead } = bytes.length
      ? await file.read(bytes, 0, bytes.length, cursor.offset)
      : { bytesRead: 0 }
    const content = Buffer.concat([cursor.carry, bytes.subarray(0, bytesRead)])
    const records: Record<string, unknown>[] = []
    let start = 0
    for (let end = content.indexOf(10); end !== -1; end = content.indexOf(10, start)) {
      if (!cursor.skipping && end - start <= LINE_BYTES) {
        try {
          const value: unknown = JSON.parse(content.toString('utf8', start, end))
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            records.push({ ...value })
          }
        } catch {
          /* A malformed line supplies no lifecycle evidence. */
        }
      }
      cursor.skipping = false
      start = end + 1
    }
    const tail = content.subarray(start)
    cursor.skipping ||= tail.length > LINE_BYTES
    cursor.carry = cursor.skipping ? Buffer.alloc(0) : Buffer.from(tail)
    cursor.offset += bytesRead
    return {
      records,
      reset,
      caughtUp: cursor.offset >= stats.size && cursor.carry.length === 0 && !cursor.skipping
    }
  } catch {
    return undefined
  } finally {
    await file?.close().catch(() => {})
  }
}
