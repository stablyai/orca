import type { Stats } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import {
  boundTranscriptDirectory,
  firstRecordError,
  FIRST_RECORD_OPEN_FLAGS,
  parseJsonlFirstRecord,
  planJsonlRead,
  sameJsonlFile,
  sameJsonlFingerprint,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFileFingerprint,
  type JsonlFirstRecord
} from './codex-rollout-jsonl-format'

import { type RolloutReadBatch, withRolloutReadSlot } from './codex-rollout-read-slots'

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
    () => readJsonlFirstRecordAsyncUnslotted(filePath, batch),
    batch,
    'unreadable'
  )
}

async function readJsonlFirstRecordAsyncUnslotted(
  filePath: string,
  batch: RolloutReadBatch
): Promise<JsonlFirstRecord> {
  // Over the held-bytes budget reads as a transient failure; the identity retry comes back later.
  if (!batch.reserve(TRANSCRIPT_LINE_MAX_BYTES)) {
    return 'unreadable'
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, FIRST_RECORD_OPEN_FLAGS)
    if (!batch.wanted()) {
      return 'unreadable'
    }
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    if (!batch.wanted()) {
      return 'unreadable'
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return batch.wanted() ? parseJsonlFirstRecord(buffer, bytesRead) : 'unreadable'
  } catch (error) {
    return firstRecordError(error)
  } finally {
    // The buffer is parsed and dropped here, so it holds none of the budget afterwards.
    batch.unreserve(TRANSCRIPT_LINE_MAX_BYTES)
    await handle?.close().catch(() => {})
  }
}

/** Reads a cursor's new bytes off the main thread without moving it; undefined when unreadable or vanished, 'deferred' when the batch should retry next time. */
export function readJsonlCursorBytes(
  cursor: JsonlCursor,
  batch: RolloutReadBatch,
  mode: 'tail' | 'forward' = 'tail',
  trackFile?: { previous?: JsonlFileFingerprint }
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  return withRolloutReadSlot(
    () => readJsonlCursorBytesUnslotted(cursor, batch, mode, trackFile),
    batch,
    'deferred'
  )
}

function completeUtf8Prefix(buffer: Buffer): Buffer {
  // Leave a split character on disk so the forward cursor decodes it with the next chunk.
  for (let index = buffer.length - 1; index >= Math.max(0, buffer.length - 3); index--) {
    const byte = buffer[index]!
    if ((byte & 0xc0) === 0x80) {
      continue
    }
    const width = byte < 0xc0 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    return buffer.length - index < width ? buffer.subarray(0, index) : buffer
  }
  return buffer
}

function jsonlFingerprint(stats: Stats): JsonlFileFingerprint {
  const { dev, ino, birthtimeMs, size, mtimeMs, ctimeMs } = stats
  return { dev, ino, birthtimeMs, size, mtimeMs, ctimeMs }
}

async function readJsonlCursorBytesUnslotted(
  cursor: JsonlCursor,
  batch: RolloutReadBatch,
  mode: 'tail' | 'forward',
  trackFile?: { previous?: JsonlFileFingerprint }
): Promise<JsonlCursorBytes | undefined | 'deferred'> {
  if (!cursor.filePath) {
    return undefined
  }
  const snapshot = { ...cursor, filePath: cursor.filePath }
  let handle: FileHandle | undefined
  let plan: (JsonlCursorBytes & { length: number }) | undefined
  try {
    const previous = trackFile?.previous
    if (previous && snapshot.offset === previous.size) {
      const pathStats = await stat(snapshot.filePath)
      if (!pathStats.isFile()) {
        return undefined
      }
      if (sameJsonlFingerprint(previous, jsonlFingerprint(pathStats))) {
        return { ...planJsonlRead(snapshot, previous.size, mode), fingerprint: previous }
      }
      if (!batch.wanted()) {
        return 'deferred'
      }
    }
    if (trackFile) {
      // Bind the fingerprint and byte range to the same opened file.
      handle = await open(snapshot.filePath, FIRST_RECORD_OPEN_FLAGS)
      if (!batch.wanted()) {
        return 'deferred'
      }
    }
    const stats = handle ? await handle.stat() : await stat(snapshot.filePath)
    if (!stats.isFile()) {
      return undefined
    }
    const { size } = stats
    const fingerprint = trackFile && jsonlFingerprint(stats)
    const reset = Boolean(
      fingerprint &&
      previous &&
      (!sameJsonlFile(previous, fingerprint) ||
        size < previous.size ||
        (size === previous.size && !sameJsonlFingerprint(previous, fingerprint)))
    )
    plan = planJsonlRead(snapshot, size, mode, reset)
    if (fingerprint) {
      plan.fingerprint = fingerprint
    }
    if (plan.length === 0) {
      return plan
    }
    if (!batch.wanted() || !batch.reserve(plan.length)) {
      return 'deferred'
    }
    handle ??= await open(plan.filePath, 'r')
    if (!batch.wanted()) {
      return 'deferred'
    }
    const buffer = Buffer.allocUnsafe(plan.length)
    const { bytesRead } = await handle.read(buffer, 0, plan.length, plan.start)
    const bytes = buffer.subarray(0, bytesRead)
    if (mode === 'forward') {
      return {
        ...plan,
        bytes: completeUtf8Prefix(bytes),
        hasMore: plan.start + bytesRead < size ? true : undefined
      }
    }
    return { ...plan, bytes }
  } catch {
    return plan && { ...plan, failed: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function readTranscriptDirectoryAsync(
  directory: string,
  batch: RolloutReadBatch
): Promise<string[]> {
  return withRolloutReadSlot(() => readTranscriptDirectoryAsyncUnslotted(directory), batch, [])
}

async function readTranscriptDirectoryAsyncUnslotted(directory: string): Promise<string[]> {
  try {
    return boundTranscriptDirectory(await readdir(directory))
  } catch {
    return []
  }
}
