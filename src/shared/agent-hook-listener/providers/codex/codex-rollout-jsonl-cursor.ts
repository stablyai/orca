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

// Re-opening a hot transcript on every poll re-triggers open-time scanning on Windows and stalls
// the main thread for seconds (#43539); one held descriptor per cursor reads new bytes instead.
const cursorFileDescriptors = new WeakMap<JsonlCursor, number>()

/** Release a cursor's held descriptor; safe for never-read cursors and already-closed ones. */
export function closeJsonlCursor(cursor: JsonlCursor): void {
  const fd = cursorFileDescriptors.get(cursor)
  if (fd !== undefined) {
    cursorFileDescriptors.delete(cursor)
    closeSync(fd)
  }
}

/** Read through one held descriptor per cursor, reopening only after the handle went stale. */
function readCursorBytes(cursor: JsonlCursor, buffer: Buffer, start: number): number {
  let fd = cursorFileDescriptors.get(cursor)
  try {
    if (fd === undefined) {
      fd = openSync(cursor.filePath as string, 'r')
      cursorFileDescriptors.set(cursor, fd)
    }
    return readSync(fd, buffer, 0, buffer.length, start)
  } catch (error) {
    // A held handle can go stale (recreated or removed file); drop it so the next poll reopens.
    if (fd !== undefined) {
      cursorFileDescriptors.delete(cursor)
      closeSync(fd)
    }
    throw error
  }
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/** 'pending' while the file or its first line is unwritten; 'unreadable' on other I/O failures; undefined once the line is final. */
export function readJsonlFirstRecord(
  filePath: string
): JsonRecord | 'pending' | 'unreadable' | undefined {
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
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (newline === -1) {
      return bytesRead < buffer.length ? 'pending' : undefined
    }
    return record(JSON.parse(buffer.toString('utf8', 0, newline)))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'pending'
      : 'unreadable'
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
    // A smaller file is a recreated one; its held descriptor (if any) names the old inode.
    closeJsonlCursor(cursor)
    cursor.offset = 0
    cursor.carry = ''
  }
  if (stats.size === cursor.offset) {
    return []
  }
  const bytesToRead = Math.min(stats.size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
  const start = stats.size - cursor.offset > bytesToRead ? stats.size - bytesToRead : cursor.offset
  const buffer = Buffer.allocUnsafe(bytesToRead)
  let bytesRead: number
  try {
    bytesRead = readCursorBytes(cursor, buffer, start)
  } catch {
    return undefined
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
