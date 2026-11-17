import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import {
  boundTranscriptDirectory,
  firstRecordError,
  FIRST_RECORD_OPEN_FLAGS,
  parseJsonlFirstRecord,
  planJsonlRead,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFirstRecord
} from './codex-rollout-jsonl-format'

// Why: an open stalled by an on-access scan holds a libuv thread (4 by default); leave one free for other file work.
const MAX_CONCURRENT_ROLLOUT_READS = 3
let rolloutReadsInFlight = 0
const rolloutReadQueue: (() => void)[] = []

async function withRolloutReadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (rolloutReadsInFlight < MAX_CONCURRENT_ROLLOUT_READS) {
    rolloutReadsInFlight += 1
  } else {
    // A freed slot passes straight to the oldest waiter, so the count never overshoots.
    await new Promise<void>((resolve) => rolloutReadQueue.push(resolve))
  }
  try {
    return await run()
  } finally {
    const next = rolloutReadQueue.shift()
    if (next) {
      next()
    } else {
      rolloutReadsInFlight -= 1
    }
  }
}

export function rolloutFileSizeAsync(filePath: string): Promise<number | null> {
  return withRolloutReadSlot(() => rolloutFileSizeAsyncUnslotted(filePath))
}

async function rolloutFileSizeAsyncUnslotted(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

/** Off-thread twin of readJsonlFirstRecord for main-process polls. */
export function readJsonlFirstRecordAsync(filePath: string): Promise<JsonlFirstRecord> {
  return withRolloutReadSlot(() => readJsonlFirstRecordAsyncUnslotted(filePath))
}

async function readJsonlFirstRecordAsyncUnslotted(filePath: string): Promise<JsonlFirstRecord> {
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

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished. */
export function readJsonlCursorBytes(cursor: JsonlCursor): Promise<JsonlCursorBytes | undefined> {
  return withRolloutReadSlot(() => readJsonlCursorBytesUnslotted(cursor))
}

async function readJsonlCursorBytesUnslotted(
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

export function readTranscriptDirectoryAsync(directory: string): Promise<string[]> {
  return withRolloutReadSlot(() => readTranscriptDirectoryAsyncUnslotted(directory))
}

async function readTranscriptDirectoryAsyncUnslotted(directory: string): Promise<string[]> {
  try {
    return boundTranscriptDirectory(await readdir(directory))
  } catch {
    return []
  }
}
