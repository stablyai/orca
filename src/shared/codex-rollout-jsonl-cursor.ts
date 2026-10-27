import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Stats
} from 'node:fs'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
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

/** Undefined distinguishes unreadable/vanished files from no new lines; lineFilter rejects raw substrings before JSON.parse. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  let stats: Stats
  try {
    stats = statSync(cursor.filePath)
  } catch {
    return undefined
  }
  if (!stats.isFile()) {
    return undefined
  }
  if (stats.size < cursor.offset) {
    cursor.offset = 0
    cursor.carry = ''
  }
  if (stats.size === cursor.offset) {
    return []
  }
  const bytesToRead = Math.min(stats.size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
  const start = stats.size - cursor.offset > bytesToRead ? stats.size - bytesToRead : cursor.offset
  const buffer = Buffer.allocUnsafe(bytesToRead)
  let bytesRead = 0
  let fd: number | undefined
  try {
    fd = openSync(cursor.filePath, 'r')
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  const skippedPrefix = start !== cursor.offset
  const content = `${skippedPrefix ? '' : cursor.carry}${buffer.toString('utf8', 0, bytesRead)}`
  const lines = content.split('\n')
  cursor.offset = start + bytesRead
  cursor.carry = lines.pop() ?? ''
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
