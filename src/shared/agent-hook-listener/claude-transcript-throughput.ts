import type { AgentMessageThroughput } from '../agent-throughput-types'
import { parseAgentHookJson } from './request-body'
import { readLastExtractedFromTranscriptOnce } from './transcript-reader'

/** Fields of one Claude Code transcript row that throughput measurement reads. */
export type ClaudeTranscriptThroughputRow = {
  type: string
  uuid: string | null
  parentUuid: string | null
  timestamp: number
  messageId: string | null
  model: string | null
  outputTokens: number
}

export type ClaudeMessageThroughput = AgentMessageThroughput

// Why: a message's blocks are interleaved with the results of the tools it calls, so the walk
// back to the previous assistant message can cross many rows; bound it instead of scanning to
// the file start.
const ROW_LOOKBACK_LIMIT = 512

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

export function parseClaudeTranscriptThroughputRow(
  line: string
): ClaudeTranscriptThroughputRow | null {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return null
  }
  const record = readObject(entry)
  if (!record) {
    return null
  }
  const type = readString(record, 'type')
  const timestamp = readTimestamp(record.timestamp)
  // Why: sidechain rows belong to a subagent's own conversation, so they neither end nor start a message here.
  if (!type || !Number.isFinite(timestamp) || record.isSidechain === true) {
    return null
  }
  const message = readObject(record.message)
  const outputTokens = readObject(message?.usage)?.output_tokens
  return {
    type,
    uuid: readString(record, 'uuid'),
    parentUuid: readString(record, 'parentUuid'),
    timestamp,
    messageId: message ? readString(message, 'id') : null,
    model: message ? readString(message, 'model') : null,
    outputTokens:
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
        ? outputTokens
        : 0
  }
}

type PendingMessage = {
  messageId: string
  model: string | null
  outputTokens: number
  completedAt: number
}

export type ClaudeMessageThroughputExtractor = {
  /** Visits transcript lines newest-first; yields once the previous assistant message is reached. */
  visit: (line: string) => ClaudeMessageThroughput | undefined
  /** Resolves against the rows seen so far when the scan ended before a previous message appeared. */
  flush: () => ClaudeMessageThroughput | undefined
}

/**
 * Claude Code writes one row per content block, stamped with the block's completion time, and
 * flushes rows in batches while tool calls already run, so a message's rows are interleaved with
 * its own tool results and with rows written mid-stream (queued input, reminders) that can carry
 * later timestamps. The message ends at its last block. It starts at the row its first block
 * points to via `parentUuid` — the last row prepared before the API request — or, when that row
 * carries a stale timestamp, at the last user row before the message, whichever is later.
 */
export function createClaudeMessageThroughputExtractor(): ClaudeMessageThroughputExtractor {
  let pending: PendingMessage | null = null
  let wantedParentUuid: string | null = null
  let parentStartAt: number | null = null
  let lastUserRowAt: number | null = null
  let rowsPastMessage = 0

  const resolveStart = (fallback: number | null): number | null => {
    if (parentStartAt !== null && lastUserRowAt !== null) {
      return Math.max(parentStartAt, lastUserRowAt)
    }
    return parentStartAt ?? lastUserRowAt ?? fallback
  }

  const finish = (startedAt: number | null): ClaudeMessageThroughput | undefined => {
    if (!pending || startedAt === null) {
      return undefined
    }
    const generationMs = pending.completedAt - startedAt
    if (!(generationMs > 0)) {
      return undefined
    }
    return {
      messageId: pending.messageId,
      model: pending.model,
      outputTokens: pending.outputTokens,
      generationMs,
      completedAt: pending.completedAt
    }
  }

  return {
    visit: (line) => {
      const row = parseClaudeTranscriptThroughputRow(line)
      if (!row) {
        return undefined
      }
      if (!pending) {
        // Why: rows without usage (API-error placeholders) carry no generation to measure; keep scanning.
        if (row.type !== 'assistant' || !row.messageId || row.outputTokens <= 0) {
          return undefined
        }
        pending = {
          messageId: row.messageId,
          model: row.model,
          outputTokens: row.outputTokens,
          completedAt: row.timestamp
        }
        wantedParentUuid = row.parentUuid
        return undefined
      }
      if (row.type === 'assistant') {
        if (row.messageId === pending.messageId) {
          // Why: an earlier block of the same message; everything seen since belonged inside it.
          pending.outputTokens = Math.max(pending.outputTokens, row.outputTokens)
          pending.model ??= row.model
          wantedParentUuid = row.parentUuid
          parentStartAt = null
          lastUserRowAt = null
          return undefined
        }
        // Why: the previous assistant message bounds this one; with nothing in between (API retry), its last row is the start.
        return finish(resolveStart(row.timestamp))
      }
      if (row.uuid !== null && row.uuid === wantedParentUuid) {
        parentStartAt = row.timestamp
      }
      if (row.type === 'user') {
        lastUserRowAt = Math.max(lastUserRowAt ?? Number.NEGATIVE_INFINITY, row.timestamp)
      }
      rowsPastMessage += 1
      return rowsPastMessage >= ROW_LOOKBACK_LIMIT ? finish(resolveStart(null)) : undefined
    },
    flush: () => finish(resolveStart(null))
  }
}

/** Throughput of the newest completed assistant message in a Claude Code transcript. */
export function readLastClaudeMessageThroughput(
  transcriptPath: string
): ClaudeMessageThroughput | undefined {
  const extractor = createClaudeMessageThroughputExtractor()
  return readLastExtractedFromTranscriptOnce(transcriptPath, extractor.visit) ?? extractor.flush()
}
