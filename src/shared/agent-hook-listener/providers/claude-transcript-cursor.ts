import { open, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { ClaudeTranscriptDecoder } from './claude-transcript-decoder'

const CHUNK_BYTES = 1024 * 1024
const TOKEN_BYTES = 64 * 1024

export type ClaudeTranscriptCursor = {
  path: string
  offset: number
  identity?: string
  decoder: ClaudeTranscriptDecoder
  utf8: StringDecoder
}
export type ClaudeTranscriptConsumer = {
  current: () => boolean
  reset: () => void
  consume: (record: Record<string, unknown>) => Promise<void>
}

export function createClaudeTranscriptCursor(path: string): ClaudeTranscriptCursor {
  return {
    path,
    offset: 0,
    decoder: new ClaudeTranscriptDecoder(),
    utf8: new StringDecoder('utf8')
  }
}

/** Physical position advances with decoding; semantic coverage also waits for ordered application. */
export async function readClaudeTranscriptChunk(
  cursor: ClaudeTranscriptCursor,
  limit = CHUNK_BYTES,
  consumer?: ClaudeTranscriptConsumer
) {
  let file: FileHandle | undefined
  try {
    file = await open(cursor.path, 'r').catch(() => undefined)
    if (!file) {
      return undefined
    }
    const stats = await file.stat().catch(() => undefined)
    if (!stats?.isFile()) {
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
      cursor.decoder = new ClaudeTranscriptDecoder()
      cursor.utf8 = new StringDecoder('utf8')
      consumer?.reset()
    }
    cursor.identity = identity
    const bytes = Buffer.alloc(
      Math.min(limit, CHUNK_BYTES, Math.max(0, stats.size - cursor.offset))
    )
    const read = bytes.length
      ? await file.read(bytes, 0, bytes.length, cursor.offset).catch(() => undefined)
      : { bytesRead: 0 }
    if (!read) {
      return undefined
    }
    const { bytesRead } = read
    const records: Record<string, unknown>[] = []
    let start = 0
    let yieldedAt = 0
    let tokenWork = 0
    while (start < bytesRead) {
      if (consumer && !consumer.current()) {
        return undefined
      }
      const lf = bytes.indexOf(10, start)
      const end = Math.min(start + TOKEN_BYTES, lf === -1 ? bytesRead : lf, bytesRead)
      const before = cursor.decoder.work
      cursor.decoder.write(cursor.utf8.write(bytes.subarray(start, end)))
      tokenWork += cursor.decoder.work - before
      cursor.offset += end - start
      start = end
      if (lf === end) {
        cursor.decoder.write(cursor.utf8.end())
        const record = cursor.decoder.end()
        cursor.decoder = new ClaudeTranscriptDecoder()
        cursor.utf8 = new StringDecoder('utf8')
        cursor.offset++
        start++
        if (record) {
          if (consumer) {
            await consumer.consume(record)
          } else {
            records.push(record)
          }
        }
      }
      if (start - yieldedAt >= TOKEN_BYTES || tokenWork >= TOKEN_BYTES) {
        yieldedAt = start
        tokenWork = 0
        await yieldToEventLoop()
      }
    }
    return { records, reset, caughtUp: cursor.offset >= stats.size && !cursor.decoder.unfinished }
  } finally {
    await file?.close().catch(() => {})
  }
}
