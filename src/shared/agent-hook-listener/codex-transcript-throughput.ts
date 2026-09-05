import type { AgentMessageThroughput } from '../agent-throughput-types'
import { parseAgentHookJson } from './request-body'
import { readLastExtractedFromTranscriptOnce } from './transcript-reader'

/**
 * One Codex rollout row, classified for throughput measurement.
 *
 * Codex writes rows in this order per model call: the call's own rows (reasoning, message,
 * function call), then the tool's output, then a `token_count` snapshot for that call. So the
 * call ends at its last model row, not at the snapshot, and starts at the row before its first
 * model row (the previous tool output, the user's message, or the previous snapshot).
 */
export type CodexRolloutThroughputRow = {
  kind: 'model' | 'boundary' | 'skip'
  timestamp: number
  /** `last_token_usage.output_tokens` of a token_count row; 0 for every other row. */
  lastOutputTokens: number
  /** Cumulative totals of a token_count row; identical on Codex's duplicate emissions. */
  totalsKey: string | null
}

// Why: a snapshot without a preceding boundary row is malformed; bound the walk instead of
// scanning to the file start (rollouts grow past a gigabyte).
const BOUNDARY_ROW_LOOKBACK_LIMIT = 64

const MODEL_RESPONSE_ITEMS: ReadonlySet<string> = new Set([
  'reasoning',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call'
])
const MODEL_EVENTS: ReadonlySet<string> = new Set([
  'agent_reasoning',
  'agent_reasoning_section_break',
  'agent_reasoning_raw_content',
  'agent_message'
])

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function classifyRow(
  type: string,
  payloadType: string | null,
  role: string | null
): CodexRolloutThroughputRow['kind'] {
  if (type === 'response_item') {
    const isModel =
      (payloadType !== null && MODEL_RESPONSE_ITEMS.has(payloadType)) ||
      (payloadType === 'message' && role === 'assistant')
    return isModel ? 'model' : 'boundary'
  }
  if (type === 'event_msg') {
    return payloadType !== null && MODEL_EVENTS.has(payloadType) ? 'model' : 'boundary'
  }
  return 'boundary'
}

export function parseCodexRolloutThroughputRow(line: string): CodexRolloutThroughputRow | null {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return null
  }
  const record = readObject(entry)
  const type = record ? readString(record, 'type') : null
  const timestamp =
    typeof record?.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  if (!record || !type || !Number.isFinite(timestamp)) {
    return null
  }
  const payload = readObject(record.payload)
  const payloadType = payload ? readString(payload, 'type') : null
  if (type !== 'event_msg' || payloadType !== 'token_count') {
    return {
      kind: classifyRow(type, payloadType, payload ? readString(payload, 'role') : null),
      timestamp,
      lastOutputTokens: 0,
      totalsKey: null
    }
  }
  const info = readObject(payload?.info)
  const totals = readObject(info?.total_token_usage)
  const last = readObject(info?.last_token_usage)
  if (!totals || !last) {
    // Why: rate-limit refreshes reuse token_count with null info; they are not call boundaries.
    return { kind: 'skip', timestamp, lastOutputTokens: 0, totalsKey: null }
  }
  return {
    kind: 'boundary',
    timestamp,
    lastOutputTokens: readCount(last.output_tokens),
    totalsKey: `${readCount(totals.input_tokens)}:${readCount(totals.output_tokens)}:${readCount(totals.total_tokens)}`
  }
}

type PendingCall = {
  totalsKey: string
  outputTokens: number
  /** Timestamp of the call's last model row once phase 2 begins; null while still in phase 1. */
  completedAt: number | null
}

export type CodexMessageThroughputExtractor = {
  /** Visits rollout lines newest-first; yields once the newest call's boundary row is known. */
  visit: (line: string) => AgentMessageThroughput | undefined
  /** Resolves against the nearest earlier row when the scan ended before a boundary was seen. */
  flush: () => AgentMessageThroughput | undefined
}

export function createCodexMessageThroughputExtractor(): CodexMessageThroughputExtractor {
  let pending: PendingCall | null = null
  let nearestEarlierRowAt: number | null = null
  let rowsPastCompletion = 0

  const finish = (startedAt: number | null): AgentMessageThroughput | undefined => {
    if (!pending || pending.completedAt === null || startedAt === null) {
      return undefined
    }
    const generationMs = pending.completedAt - startedAt
    if (!(generationMs > 0)) {
      return undefined
    }
    return {
      // Why: token_count rows carry no id; cumulative totals are unique per completed call.
      messageId: `codex:${pending.totalsKey}`,
      model: null,
      outputTokens: pending.outputTokens,
      generationMs,
      completedAt: pending.completedAt
    }
  }

  return {
    visit: (line) => {
      const row = parseCodexRolloutThroughputRow(line)
      if (!row || row.kind === 'skip') {
        return undefined
      }
      if (!pending) {
        if (row.totalsKey && row.lastOutputTokens > 0) {
          pending = {
            totalsKey: row.totalsKey,
            outputTokens: row.lastOutputTokens,
            completedAt: null
          }
        }
        return undefined
      }
      if (row.totalsKey === pending.totalsKey) {
        // Why: Codex re-emits the same snapshot; both sit after the call's rows.
        return undefined
      }
      if (pending.completedAt === null) {
        // Phase 1: the tool output written after the call is not part of it; the first model row is.
        if (row.kind === 'model') {
          pending.completedAt = row.timestamp
        }
        return undefined
      }
      // Phase 2: the call's own rows continue until the previous boundary.
      if (row.kind === 'model') {
        return undefined
      }
      rowsPastCompletion += 1
      nearestEarlierRowAt ??= row.timestamp
      return (
        finish(row.timestamp) ??
        (rowsPastCompletion >= BOUNDARY_ROW_LOOKBACK_LIMIT
          ? finish(nearestEarlierRowAt)
          : undefined)
      )
    },
    flush: () => finish(nearestEarlierRowAt)
  }
}

/** Throughput of the newest completed model call in a Codex rollout transcript. */
export function readLastCodexMessageThroughput(
  transcriptPath: string
): AgentMessageThroughput | undefined {
  const extractor = createCodexMessageThroughputExtractor()
  return readLastExtractedFromTranscriptOnce(transcriptPath, extractor.visit) ?? extractor.flush()
}
