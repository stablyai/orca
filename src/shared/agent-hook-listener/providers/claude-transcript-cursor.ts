import { open, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { ClaudeTranscriptDecoder, type ClaudeTranscriptInput } from './claude-transcript-decoder'

const CHUNK_BYTES = 1024 * 1024
const TOKEN_BYTES = 64 * 1024

export type ClaudeTranscriptApplication = {
  index: number
  at?: number
  operation?: () => void
  complete?: boolean
  text?: boolean
  result?: boolean
}
export type ClaudeTranscriptCursor = {
  path: string
  offset: number
  identity?: string
  decoder: ClaudeTranscriptDecoder
  utf8: StringDecoder
  input?: { bytes: Buffer; next: number }
  decoding?: { text: string; checkpoint: ClaudeTranscriptInput; lf: boolean }
  record?: { value: Record<string, unknown>; application: ClaudeTranscriptApplication }
}
export type ClaudeTranscriptConsumer = {
  current: () => boolean
  reset: () => void
  consume: (
    record: Record<string, unknown>,
    application: ClaudeTranscriptApplication
  ) => Promise<boolean>
}

export function createClaudeTranscriptCursor(path: string): ClaudeTranscriptCursor {
  return {
    path,
    offset: 0,
    decoder: new ClaudeTranscriptDecoder(),
    utf8: new StringDecoder('utf8')
  }
}

export function clearClaudeTranscriptCursor(cursor: ClaudeTranscriptCursor): void {
  cursor.input = undefined
  cursor.decoding = undefined
  cursor.record = undefined
  cursor.decoder = new ClaudeTranscriptDecoder()
  cursor.utf8 = new StringDecoder('utf8')
}

/** Physical progress owns pending work until ordered semantic acknowledgement. */
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
    const fetchedEnd =
      cursor.offset + (cursor.input ? cursor.input.bytes.length - cursor.input.next : 0)
    if (
      (cursor.identity !== undefined && cursor.identity !== identity) ||
      stats.size < fetchedEnd
    ) {
      reset = true
      cursor.offset = stats.size
      clearClaudeTranscriptCursor(cursor)
      consumer?.reset()
    }
    cursor.identity = identity
    const records: Record<string, unknown>[] = []
    let fetched = cursor.input !== undefined
    let byteWork = 0
    let tokenWork = 0
    for (;;) {
      if (consumer && !consumer.current()) {
        return undefined
      }
      if (cursor.record) {
        const record = cursor.record
        if (consumer) {
          if ((await consumer.consume(record.value, record.application)) === false) {
            return undefined
          }
          if (!consumer.current()) {
            return undefined
          }
        } else {
          records.push(record.value)
        }
        cursor.record = undefined
      }
      if (cursor.decoding) {
        const decoding = cursor.decoding
        const before = cursor.decoder.work
        cursor.decoder.write(decoding.text, decoding.checkpoint)
        tokenWork += cursor.decoder.work - before
        if (decoding.lf) {
          const value = cursor.decoder.end()
          if (value) {
            cursor.record = { value, application: { index: 0 } }
          }
          cursor.decoder = new ClaudeTranscriptDecoder()
          cursor.utf8 = new StringDecoder('utf8')
        }
        cursor.decoding = undefined
        continue
      }
      if (byteWork >= TOKEN_BYTES || tokenWork >= TOKEN_BYTES) {
        byteWork = tokenWork = 0
        await yieldToEventLoop()
        continue
      }
      if (!cursor.input || cursor.input.next === cursor.input.bytes.length) {
        cursor.input = undefined
        if (fetched) {
          break
        }
        fetched = true
        const bytes = Buffer.alloc(
          Math.min(limit, CHUNK_BYTES, Math.max(0, stats.size - cursor.offset))
        )
        if (!bytes.length) {
          break
        }
        const read = await file.read(bytes, 0, bytes.length, cursor.offset).catch(() => undefined)
        if (!read) {
          return undefined
        }
        if (!read.bytesRead) {
          break
        }
        cursor.input = { bytes: bytes.subarray(0, read.bytesRead), next: 0 }
      }
      const input = cursor.input
      const lf = input.bytes.indexOf(10, input.next)
      const end = Math.min(
        input.next + TOKEN_BYTES,
        lf === -1 ? input.bytes.length : lf,
        input.bytes.length
      )
      const text = cursor.utf8.write(input.bytes.subarray(input.next, end))
      const atLf = lf === end
      cursor.decoding = {
        text: text + (atLf ? cursor.utf8.end() : ''),
        checkpoint: { next: 0 },
        lf: atLf
      }
      const consumed = end - input.next + (atLf ? 1 : 0)
      input.next += consumed
      cursor.offset += consumed
      byteWork += consumed
    }
    return { records, reset, caughtUp: cursor.offset >= stats.size && !cursor.decoder.unfinished }
  } finally {
    await file?.close().catch(() => {})
  }
}
