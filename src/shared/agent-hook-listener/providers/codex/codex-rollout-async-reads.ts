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
import {
  type RolloutRead,
  type RolloutReadBatch,
  withRolloutReadSlot
} from './codex-rollout-read-slots'

export { RolloutReadBatch } from './codex-rollout-read-slots'

export function rolloutFileSizeAsync(
  filePath: string,
  batch: RolloutReadBatch
): Promise<number | null> {
  return withRolloutReadSlot(() => rolloutFileSizeAsyncUnslotted(filePath), batch, null)
}

async function rolloutFileSizeAsyncUnslotted(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

/** Off-thread twin of readJsonlFirstRecord for main-process polls. */
export function readJsonlFirstRecordAsync(
  filePath: string,
  batch: RolloutReadBatch
): Promise<JsonlFirstRecord> {
  return withRolloutReadSlot(
    (read) => readJsonlFirstRecordAsyncUnslotted(filePath, read),
    batch,
    'unreadable'
  )
}

async function readJsonlFirstRecordAsyncUnslotted(
  filePath: string,
  read: RolloutRead
): Promise<JsonlFirstRecord> {
  // Over the held-bytes budget reads as a transient failure; the identity retry comes back later.
  if (!read.reserve(TRANSCRIPT_LINE_MAX_BYTES, 'read')) {
    return 'unreadable'
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!read.wanted()) {
      return 'unreadable'
    }
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    if (!read.wanted()) {
      return 'unreadable'
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return read.wanted() ? parseJsonlFirstRecord(buffer, bytesRead) : 'unreadable'
  } catch (error) {
    return firstRecordError(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished, 'deferred' when the batch should retry next time. */
export function readJsonlCursorBytes(
  cursor: JsonlCursor,
  batch: RolloutReadBatch
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  return withRolloutReadSlot(
    (read) => readJsonlCursorBytesUnslotted(cursor, read),
    batch,
    'deferred'
  )
}

async function readJsonlCursorBytesUnslotted(
  cursor: JsonlCursor,
  read: RolloutRead
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  if (!cursor.filePath) {
    return undefined
  }
  const snapshot = { ...cursor, filePath: cursor.filePath }
  let size: number
  try {
    const stats = await stat(snapshot.filePath)
    if (!read.wanted()) {
      return 'deferred'
    }
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
  if (!read.reserve(plan.length, 'batch')) {
    return 'deferred'
  }
  let handle: FileHandle | undefined
  try {
    // Why: open per read, never held, so a replaced rollout is always read at its current path.
    handle = await open(plan.filePath, 'r')
    if (!read.wanted()) {
      return 'deferred'
    }
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    return read.wanted() ? { ...plan, bytes: buffer.subarray(0, bytesRead) } : 'deferred'
  } catch {
    return { ...plan, failed: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function readTranscriptDirectoryAsync(
  directory: string,
  batch: RolloutReadBatch
): Promise<string[]> {
  return withRolloutReadSlot(
    (read) => readTranscriptDirectoryAsyncUnslotted(directory, read),
    batch,
    []
  )
}

async function readTranscriptDirectoryAsyncUnslotted(
  directory: string,
  read: RolloutRead
): Promise<string[]> {
  try {
    const entries = await readdir(directory)
    return read.wanted() ? boundTranscriptDirectory(entries) : []
  } catch {
    return []
  }
}
