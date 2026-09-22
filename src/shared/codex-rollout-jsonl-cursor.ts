import { closeSync, readSync, readdirSync } from 'node:fs'

import { openAgentTranscriptRead } from './agent-hook-listener/transcript-reader'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

/** Resume point for an incremental read of one Codex rollout file. */
export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines. */
export function readJsonlCursor(cursor: JsonlCursor): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  const opened = openAgentTranscriptRead(cursor.filePath, { allowEmpty: true })
  if (!opened) {
    return undefined
  }
  const { fd, size } = opened
  try {
    if (size < cursor.offset) {
      cursor.offset = 0
      cursor.carry = ''
    }
    if (size === cursor.offset) {
      return []
    }
    const bytesToRead = Math.min(size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
    const start = size - cursor.offset > bytesToRead ? size - bytesToRead : cursor.offset
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
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
        const parsed = record(JSON.parse(line) as unknown)
        if (parsed) {
          records.push(parsed)
        }
      } catch {
        // A malformed rollout line must not block later lifecycle events.
      }
    }
    return records
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
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
