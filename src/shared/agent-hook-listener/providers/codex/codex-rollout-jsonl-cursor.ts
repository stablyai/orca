import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import {
  applyJsonlCursorBytes,
  planJsonlRead,
  type JsonlCursor,
  type JsonlCursorBytes,
  type JsonRecord
} from './codex-rollout-jsonl-format'

/** Undefined distinguishes unreadable/vanished files from no new lines; lineFilter rejects raw substrings before JSON.parse. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  let stats: Stats | undefined
  try {
    stats = statSync(cursor.filePath)
  } catch {
    stats = undefined
  }
  if (!stats?.isFile()) {
    return undefined
  }
  const plan = planJsonlRead({ ...cursor, filePath: cursor.filePath }, stats.size)
  let read: JsonlCursorBytes = plan
  if (plan.length > 0) {
    const buffer = Buffer.allocUnsafe(plan.length)
    let fd: number | undefined
    try {
      fd = openSync(plan.filePath, 'r')
      read = {
        ...plan,
        bytes: buffer.subarray(0, readSync(fd, buffer, 0, plan.length, plan.start))
      }
    } catch {
      read = { ...plan, failed: true }
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  }
  const records = applyJsonlCursorBytes(cursor, read, lineFilter)
  return records === 'stale' ? [] : records
}
