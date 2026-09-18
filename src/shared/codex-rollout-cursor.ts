import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024

type JsonRecord = Record<string, unknown>

export type CodexRolloutCursor = {
  filePath?: string
  offset: number
  carry: string
  turnContext?: { turnId: string; autoReview: boolean }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines. */
export function readCodexRolloutCursor(cursor: CodexRolloutCursor): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    cursor.turnContext = undefined
    return undefined
  }
  let stats: Stats
  try {
    stats = statSync(cursor.filePath)
  } catch {
    cursor.turnContext = undefined
    return undefined
  }
  if (!stats.isFile()) {
    cursor.turnContext = undefined
    return undefined
  }
  if (stats.size < cursor.offset) {
    cursor.offset = 0
    cursor.carry = ''
    cursor.turnContext = undefined
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
    cursor.turnContext = undefined
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
    if (Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES) {
      continue
    }
    try {
      const parsed = record(JSON.parse(line))
      if (parsed) {
        if (parsed.type === 'turn_context') {
          const payload = record(parsed.payload)
          cursor.turnContext =
            typeof payload?.turn_id === 'string'
              ? {
                  turnId: payload.turn_id,
                  autoReview: payload.approvals_reviewer === 'auto_review'
                }
              : undefined
        }
        records.push(parsed)
      }
    } catch {
      // A malformed rollout line must not block later lifecycle events.
    }
  }
  return records
}
