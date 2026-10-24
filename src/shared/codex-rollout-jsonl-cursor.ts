import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

/** Resume point for a bounded incremental read of one transcript file. */
export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
  incarnation?: string
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

export function readJsonlFirstRecord(filePath: string): JsonRecord | undefined {
  let fd: number | undefined
  try {
    // Nonblocking open prevents a FIFO from stalling hook handling before the descriptor check.
    fd = openSync(
      filePath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    )
    if (!fstatSync(fd).isFile()) {
      return undefined
    }
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (newline === -1) {
      return undefined
    }
    return record(JSON.parse(buffer.toString('utf8', 0, newline)))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines.
 *  `lineFilter` skips JSON.parse for raw lines the caller can reject by substring. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean,
  onGap?: () => void
): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  let fd: number | undefined
  let buffer: Buffer
  let start: number
  let bytesRead: number
  try {
    fd = openSync(
      cursor.filePath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    )
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      return undefined
    }
    const incarnation = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
    if (stats.size < cursor.offset || (cursor.incarnation && cursor.incarnation !== incarnation)) {
      cursor.offset = 0
      cursor.carry = ''
      onGap?.()
    }
    cursor.incarnation = incarnation
    if (stats.size === cursor.offset) {
      return []
    }
    const bytesToRead = Math.min(stats.size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
    start = stats.size - cursor.offset > bytesToRead ? stats.size - bytesToRead : cursor.offset
    buffer = Buffer.allocUnsafe(bytesToRead)
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
    if (onGap && bytesRead !== bytesToRead) {
      cursor.offset = stats.size
      cursor.carry = ''
      onGap()
      return []
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  const skippedPrefix = start !== cursor.offset
  if (skippedPrefix) {
    onGap?.()
  }
  const content = `${skippedPrefix ? '' : cursor.carry}${buffer.toString('utf8', 0, bytesRead)}`
  const lines = content.split('\n')
  cursor.offset = start + bytesRead
  cursor.carry = lines.pop() ?? ''
  const oversizedCarry = Buffer.byteLength(cursor.carry, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
  if (oversizedCarry) {
    cursor.carry = ''
  }
  if (skippedPrefix) {
    lines.shift()
  }
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (
      (lineFilter && !lineFilter(line)) ||
      Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
    ) {
      if (onGap) {
        records.length = 0
        onGap()
      }
      continue
    }
    try {
      const parsed = record(JSON.parse(line) as unknown)
      if (parsed) {
        records.push(parsed)
      }
    } catch {
      if (onGap) {
        records.length = 0
        onGap()
      }
      // A malformed rollout line must not block later lifecycle events.
    }
  }
  if (oversizedCarry && onGap) {
    onGap()
    return []
  }
  return records
}

export function readTranscriptDirectory(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  if (entries.length > TRANSCRIPT_DIRECTORY_MAX_ENTRIES) {
    entries = entries.slice(-TRANSCRIPT_DIRECTORY_MAX_ENTRIES)
  }
  return entries
}
