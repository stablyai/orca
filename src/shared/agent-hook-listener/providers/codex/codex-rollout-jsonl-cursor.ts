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
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
}

export type JsonRecord = Record<string, unknown>

/** Rollout reads done off the main thread before a hook is normalized; the synchronous readers use them instead of blocking. */
export type PrefetchedRolloutReads = {
  cursors: { filePath: string; offset: number; carry: string; read: JsonlCursorBytes | undefined }[]
  firstRecords: Map<string, JsonlFirstRecord>
  sizes: Map<string, number | null>
}

let prefetched: PrefetchedRolloutReads | undefined

export function createPrefetchedRolloutReads(): PrefetchedRolloutReads {
  return { cursors: [], firstRecords: new Map(), sizes: new Map() }
}

export function withPrefetchedRolloutReads<T>(
  reads: PrefetchedRolloutReads | undefined,
  run: () => T
): T {
  const previous = prefetched
  prefetched = reads
  try {
    return run()
  } finally {
    prefetched = previous
  }
}

/** Prefetches a cursor's next read; a sync read at the same position consumes it once. */
export async function prefetchJsonlCursor(
  reads: PrefetchedRolloutReads,
  cursor: JsonlCursor
): Promise<void> {
  const { filePath, offset, carry } = cursor
  if (filePath) {
    reads.cursors.push({ filePath, offset, carry, read: await readJsonlCursorBytes(cursor) })
  }
}

/** Prefetches a rollout's size, and its first record when `wantsHead(size)` says a read is due. */
export async function prefetchRolloutHead(
  reads: PrefetchedRolloutReads,
  filePath: string,
  wantsHead: (size: number | null) => boolean
): Promise<void> {
  const size = await rolloutFileSizeAsync(filePath)
  reads.sizes.set(filePath, size)
  if (wantsHead(size)) {
    reads.firstRecords.set(filePath, await readJsonlFirstRecordAsync(filePath))
  }
}

/** Inside a prefetch scope, a read nobody prefetched is deferred to the async poll instead of blocking. */
export function rolloutCursorReadDeferred(cursor: JsonlCursor): boolean {
  return (
    prefetched !== undefined &&
    !prefetched.cursors.some(
      (entry) =>
        entry.filePath === cursor.filePath &&
        entry.offset === cursor.offset &&
        entry.carry === cursor.carry
    )
  )
}

export function rolloutHeadReadDeferred(filePath: string): boolean {
  return prefetched !== undefined && !prefetched.firstRecords.has(filePath)
}

export function rolloutReadsPrefetched(): boolean {
  return prefetched !== undefined
}

export function rolloutFileSize(filePath: string): number | null {
  if (prefetched?.sizes.has(filePath)) {
    return prefetched.sizes.get(filePath) ?? null
  }
  try {
    return statSync(filePath).size
  } catch {
    return null
  }
}

export async function rolloutFileSizeAsync(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

type JsonlFirstRecord = JsonRecord | 'pending' | 'unreadable' | undefined

// Nonblocking open prevents a FIFO from stalling the reader before the descriptor check.
const FIRST_RECORD_OPEN_FLAGS =
  constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

function parseJsonlFirstRecord(buffer: Buffer, bytesRead: number): JsonlFirstRecord {
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
  if (newline === -1) {
    return bytesRead < buffer.length ? 'pending' : undefined
  }
  return record(JSON.parse(buffer.toString('utf8', 0, newline)))
}

function firstRecordError(error: unknown): JsonlFirstRecord {
  if (error instanceof SyntaxError) {
    return undefined
  }
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ? 'pending'
    : 'unreadable'
}

/** 'pending' while the file or its first line is unwritten; 'unreadable' on other I/O failures; undefined once the line is final. */
export function readJsonlFirstRecord(filePath: string): JsonlFirstRecord {
  if (prefetched?.firstRecords.has(filePath)) {
    return prefetched.firstRecords.get(filePath)
  }
  let fd: number | undefined
  try {
    fd = openSync(filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!fstatSync(fd).isFile()) {
      return undefined
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    return parseJsonlFirstRecord(buffer, readSync(fd, buffer, 0, buffer.length, 0))
  } catch (error) {
    return firstRecordError(error)
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Off-thread twin of readJsonlFirstRecord for main-process polls. */
export async function readJsonlFirstRecordAsync(filePath: string): Promise<JsonlFirstRecord> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseJsonlFirstRecord(buffer, bytesRead)
  } catch (error) {
    return firstRecordError(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** New bytes read against a cursor position; applying them to a cursor that has since moved is refused. */
export type JsonlCursorBytes = {
  filePath: string
  offset: number
  carry: string
  /** Where unread bytes begin: the cursor offset, or 0 after the file shrank. */
  from: number
  start: number
  bytes: Buffer
  /** The open or read failed after a size was seen; a shrink still resets the cursor. */
  failed?: true
}

const NO_BYTES = Buffer.alloc(0)

function planJsonlRead(
  cursor: JsonlCursor & { filePath: string },
  size: number
): JsonlCursorBytes & { length: number } {
  const from = size < cursor.offset ? 0 : cursor.offset
  const length = Math.min(size - from, TRANSCRIPT_READ_MAX_BYTES)
  const start = size - from > length ? size - length : from
  const { filePath, offset, carry } = cursor
  return { filePath, offset, carry, from, start, length, bytes: NO_BYTES }
}

function readJsonlCursorBytesSync(cursor: JsonlCursor): JsonlCursorBytes | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  const index =
    prefetched?.cursors.findIndex(
      (entry) =>
        entry.filePath === cursor.filePath &&
        entry.offset === cursor.offset &&
        entry.carry === cursor.carry
    ) ?? -1
  if (prefetched && index >= 0) {
    return prefetched.cursors.splice(index, 1)[0].read
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
  const plan = planJsonlRead({ ...cursor, filePath: cursor.filePath }, stats.size)
  if (plan.length === 0) {
    return plan
  }
  const buffer = Buffer.allocUnsafe(plan.length)
  let fd: number | undefined
  try {
    fd = openSync(plan.filePath, 'r')
    return { ...plan, bytes: buffer.subarray(0, readSync(fd, buffer, 0, plan.length, plan.start)) }
  } catch {
    return { ...plan, failed: true }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished. */
export async function readJsonlCursorBytes(
  cursor: JsonlCursor
): Promise<JsonlCursorBytes | undefined> {
  if (!cursor.filePath) {
    return undefined
  }
  const snapshot = { ...cursor, filePath: cursor.filePath }
  let size: number
  try {
    const stats = await stat(snapshot.filePath)
    if (!stats.isFile()) {
      return undefined
    }
    size = stats.size
  } catch {
    return undefined
  }
  const plan = planJsonlRead(snapshot, size)
  if (plan.length === 0) {
    return plan
  }
  let handle: FileHandle | undefined
  try {
    // Why: open per read, never held, so a replaced rollout is always read at its current path.
    handle = await open(plan.filePath, 'r')
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    return { ...plan, bytes: buffer.subarray(0, bytesRead) }
  } catch {
    return { ...plan, failed: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Advances the cursor past read bytes; 'stale' when another reader moved it since they were read. */
export function applyJsonlCursorBytes(
  cursor: JsonlCursor,
  read: JsonlCursorBytes | undefined,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined | 'stale' {
  if (!read) {
    return undefined
  }
  if (
    cursor.filePath !== read.filePath ||
    cursor.offset !== read.offset ||
    cursor.carry !== read.carry
  ) {
    return 'stale'
  }
  const carry = read.from === read.offset ? read.carry : ''
  if (read.failed) {
    cursor.offset = read.from
    cursor.carry = carry
    return undefined
  }
  if (read.bytes.length === 0) {
    cursor.offset = read.from
    cursor.carry = carry
    return []
  }
  const skippedPrefix = read.start !== read.from
  const content = `${skippedPrefix ? '' : carry}${read.bytes.toString('utf8')}`
  const lines = content.split('\n')
  cursor.offset = read.start + read.bytes.length
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

/** Undefined distinguishes unreadable/vanished files from no new lines; lineFilter rejects raw substrings before JSON.parse. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined {
  const records = applyJsonlCursorBytes(cursor, readJsonlCursorBytesSync(cursor), lineFilter)
  return records === 'stale' ? [] : records
}

function boundTranscriptDirectory(entries: string[]): string[] {
  return entries.length > TRANSCRIPT_DIRECTORY_MAX_ENTRIES
    ? entries.slice(-TRANSCRIPT_DIRECTORY_MAX_ENTRIES)
    : entries
}

export async function readTranscriptDirectoryAsync(directory: string): Promise<string[]> {
  try {
    return boundTranscriptDirectory(await readdir(directory))
  } catch {
    return []
  }
}

export function readTranscriptDirectory(directory: string): string[] {
  try {
    return boundTranscriptDirectory(readdirSync(directory))
  } catch {
    return []
  }
}
