import { constants } from 'node:fs'

export const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
export const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
  /** Bytes up to the next newline finish a line that is skipped: oversized, or its start was never read. */
  discardingLine?: boolean
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

export type JsonlFirstRecord = JsonRecord | 'pending' | 'unreadable' | undefined

// Nonblocking open prevents a FIFO from stalling the reader before the descriptor check.
export const FIRST_RECORD_OPEN_FLAGS =
  constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

export function parseJsonlFirstRecord(buffer: Buffer, bytesRead: number): JsonlFirstRecord {
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
  if (newline === -1) {
    return bytesRead < buffer.length ? 'pending' : undefined
  }
  return record(JSON.parse(buffer.toString('utf8', 0, newline)))
}

export function firstRecordError(error: unknown): JsonlFirstRecord {
  if (error instanceof SyntaxError) {
    return undefined
  }
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ? 'pending'
    : 'unreadable'
}

/** New bytes read against a cursor position; applying them to a cursor that has since moved is refused. */
export type JsonlCursorBytes = {
  filePath: string
  offset: number
  carry: string
  discardingLine?: boolean
  /** Where unread bytes begin: the cursor offset, or 0 after the file shrank. */
  from: number
  start: number
  bytes: Buffer
  /** The open or read failed after a size was seen; a shrink still resets the cursor. */
  failed?: true
}

const NO_BYTES = Buffer.alloc(0)

export function planJsonlRead(
  cursor: JsonlCursor & { filePath: string },
  size: number
): JsonlCursorBytes & { length: number } {
  const from = size < cursor.offset ? 0 : cursor.offset
  const length = Math.min(size - from, TRANSCRIPT_READ_MAX_BYTES)
  const start = size - from > length ? size - length : from
  const { filePath, offset, carry, discardingLine } = cursor
  return { filePath, offset, carry, discardingLine, from, start, length, bytes: NO_BYTES }
}

/** The part of `read` the cursor has not consumed; undefined when the read cannot serve the cursor's position. */
export function alignJsonlCursorBytes(
  cursor: JsonlCursor,
  read: JsonlCursorBytes
): JsonlCursorBytes | undefined {
  if (cursor.filePath !== read.filePath) {
    return undefined
  }
  if (
    cursor.offset === read.offset &&
    cursor.carry === read.carry &&
    !!cursor.discardingLine === !!read.discardingLine
  ) {
    return read
  }
  // Another reader consumed a prefix (or all) of these bytes since they were read; whatever remains is still new.
  const end = read.start + read.bytes.length
  if (
    read.failed ||
    read.from !== read.offset ||
    cursor.offset < Math.max(read.start, read.offset)
  ) {
    return undefined
  }
  return {
    filePath: read.filePath,
    offset: cursor.offset,
    carry: cursor.carry,
    discardingLine: cursor.discardingLine,
    from: cursor.offset,
    start: cursor.offset,
    bytes: cursor.offset >= end ? NO_BYTES : read.bytes.subarray(cursor.offset - read.start)
  }
}

/** Advances the cursor past read bytes; 'stale' when another reader moved it where these bytes cannot serve (behind them, or across a shrink). */
export function applyJsonlCursorBytes(
  cursor: JsonlCursor,
  bytesRead: JsonlCursorBytes | undefined,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined | 'stale' {
  if (!bytesRead) {
    return undefined
  }
  const read = alignJsonlCursorBytes(cursor, bytesRead)
  if (!read) {
    return 'stale'
  }
  const carry = read.from === read.offset ? read.carry : ''
  const discardingLine = read.from === read.offset && !!read.discardingLine
  if (read.failed) {
    cursor.offset = read.from
    cursor.carry = carry
    cursor.discardingLine = discardingLine
    return undefined
  }
  if (read.bytes.length === 0) {
    cursor.offset = read.from
    cursor.carry = carry
    cursor.discardingLine = discardingLine
    return []
  }
  const skippedPrefix = read.start !== read.from || discardingLine
  const content = `${skippedPrefix ? '' : carry}${read.bytes.toString('utf8')}`
  const lines = content.split('\n')
  cursor.offset = read.start + read.bytes.length
  const tail = lines.pop() ?? ''
  cursor.discardingLine =
    (skippedPrefix && lines.length === 0) ||
    Buffer.byteLength(tail, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
  cursor.carry = cursor.discardingLine ? '' : tail
  if (skippedPrefix) {
    lines.shift()
  }
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (
      (lineFilter && !lineFilter(line)) ||
      Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
    ) {
      continue
    }
    try {
      const parsed = record(JSON.parse(line) as unknown)
      if (parsed) {
        records.push(parsed)
      }
    } catch {
      // A malformed rollout line must not block later lifecycle events.
    }
  }
  return records
}

export function boundTranscriptDirectory(entries: string[]): string[] {
  return entries.length > TRANSCRIPT_DIRECTORY_MAX_ENTRIES
    ? entries.slice(-TRANSCRIPT_DIRECTORY_MAX_ENTRIES)
    : entries
}
