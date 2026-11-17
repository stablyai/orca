import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Stats
} from 'node:fs'
import {
  applyJsonlCursorBytes,
  boundTranscriptDirectory,
  firstRecordError,
  FIRST_RECORD_OPEN_FLAGS,
  parseJsonlFirstRecord,
  planJsonlRead,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonlFirstRecord,
  type JsonRecord
} from './codex-rollout-jsonl-format'
import { prefetchedFirstRecord, takePrefetchedCursorRead } from './codex-rollout-prefetch-scope'

/** 'pending' while the file or its first line is unwritten; 'unreadable' on other I/O failures; undefined once the line is final. */
export function readJsonlFirstRecord(filePath: string): JsonlFirstRecord {
  const prefetchedHead = prefetchedFirstRecord(filePath)
  if (prefetchedHead) {
    return prefetchedHead.record
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

function readJsonlCursorBytesSync(cursor: JsonlCursor): JsonlCursorBytes | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  const prefetchedRead = takePrefetchedCursorRead(cursor)
  if (prefetchedRead) {
    return prefetchedRead.read
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

/** Undefined distinguishes unreadable/vanished files from no new lines; lineFilter rejects raw substrings before JSON.parse. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined {
  const records = applyJsonlCursorBytes(cursor, readJsonlCursorBytesSync(cursor), lineFilter)
  return records === 'stale' ? [] : records
}

export function readTranscriptDirectory(directory: string): string[] {
  try {
    return boundTranscriptDirectory(readdirSync(directory))
  } catch {
    return []
  }
}
