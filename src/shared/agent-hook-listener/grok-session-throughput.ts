import { dirname, join } from 'node:path'
import type { AgentMessageThroughput } from '../agent-throughput-types'
import { parseAgentHookJson } from './request-body'
import { readLastExtractedFromTranscriptOnce } from './transcript-reader'

/**
 * Grok CLI reports no token counts anywhere on disk. `events.jsonl` times each model call
 * (`loop_started` → the first of permission_requested / tool_started / turn_ended) and
 * `chat_history.jsonl` holds what it produced, so the call's tokens are ESTIMATED from text
 * length: visible text and tool arguments plus the reasoning the CLI keeps only as an
 * encrypted blob whose size tracks the hidden reasoning. Roughly four characters per token.
 */
export const GROK_EVENTS_FILE = 'events.jsonl'
const CHARS_PER_TOKEN = 4
// Why: the encrypted reasoning is base64; three quarters of its length is the ciphertext size,
// which is the closest available proxy for the reasoning text the model generated.
const BASE64_PAYLOAD_RATIO = 0.75
const EVENT_ROW_LOOKBACK_LIMIT = 4096

export type GrokModelCallTiming = {
  loopIndex: number | null
  startedAt: number
  endedAt: number
}

export type GrokModelCallText = {
  model: string | null
  visibleChars: number
  encryptedReasoningChars: number
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    return readObject(parseAgentHookJson(line))
  } catch {
    return null
  }
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}

/** Backwards walk over events.jsonl that yields the newest model call which already ended. */
export function createGrokLoopTimingExtractor(): {
  visit: (line: string) => GrokModelCallTiming | undefined
} {
  let endedAt: number | null = null
  let rowsSeen = 0
  return {
    visit: (line) => {
      const record = parseJsonObject(line)
      const type = typeof record?.type === 'string' ? record.type : null
      const timestamp = typeof record?.ts === 'string' ? Date.parse(record.ts) : Number.NaN
      if (!record || !type || !Number.isFinite(timestamp)) {
        return undefined
      }
      rowsSeen += 1
      if (rowsSeen > EVENT_ROW_LOOKBACK_LIMIT) {
        // Why: bound the walk; a call this far back has no matching chat row worth reporting.
        return undefined
      }
      if (type === 'loop_started') {
        if (endedAt === null) {
          // Why: the newest loop is still streaming; the call before it is the last completed one.
          return undefined
        }
        const loopIndex = typeof record.loop_index === 'number' ? record.loop_index : null
        const startedAt = timestamp
        const ended = endedAt
        endedAt = null
        return ended > startedAt ? { loopIndex, startedAt, endedAt: ended } : undefined
      }
      // Why: walking backwards, the last of these seen before loop_started is the earliest one
      // after the call — permission prompts and tool runs are not generation time.
      if (type === 'permission_requested' || type === 'tool_started' || type === 'turn_ended') {
        endedAt = timestamp
      }
      return undefined
    }
  }
}

/** Backwards walk over chat_history.jsonl that yields the newest assistant row plus the reasoning rows before it. */
export function createGrokCallTextExtractor(): {
  visit: (line: string) => GrokModelCallText | undefined
  flush: () => GrokModelCallText | undefined
} {
  let pending: GrokModelCallText | null = null
  const finish = (): GrokModelCallText | undefined => {
    const result = pending ?? undefined
    pending = null
    return result
  }
  return {
    visit: (line) => {
      const record = parseJsonObject(line)
      const type = typeof record?.type === 'string' ? record.type : null
      if (!record || !type) {
        return undefined
      }
      if (!pending) {
        if (type !== 'assistant') {
          return undefined
        }
        let visibleChars = stringLength(record.content)
        if (Array.isArray(record.tool_calls)) {
          for (const call of record.tool_calls) {
            visibleChars += stringLength(readObject(call)?.arguments)
          }
        }
        pending = {
          model: typeof record.model_id === 'string' && record.model_id ? record.model_id : null,
          visibleChars,
          encryptedReasoningChars: 0
        }
        return undefined
      }
      if (type !== 'reasoning') {
        return finish()
      }
      if (Array.isArray(record.summary)) {
        for (const part of record.summary) {
          pending.visibleChars += stringLength(readObject(part)?.text)
        }
      }
      pending.encryptedReasoningChars += stringLength(record.encrypted_content)
      return undefined
    },
    flush: finish
  }
}

export function estimateGrokOutputTokens(text: GrokModelCallText): number {
  const chars = text.visibleChars + text.encryptedReasoningChars * BASE64_PAYLOAD_RATIO
  return Math.round(chars / CHARS_PER_TOKEN)
}

/** Estimated throughput of the newest completed Grok model call for a session's chat history file. */
export function readLastGrokMessageThroughput(
  chatHistoryPath: string
): AgentMessageThroughput | undefined {
  const timing = readLastExtractedFromTranscriptOnce(
    join(dirname(chatHistoryPath), GROK_EVENTS_FILE),
    createGrokLoopTimingExtractor().visit
  )
  if (!timing) {
    return undefined
  }
  const textExtractor = createGrokCallTextExtractor()
  const text =
    readLastExtractedFromTranscriptOnce(chatHistoryPath, textExtractor.visit) ??
    textExtractor.flush()
  const outputTokens = text ? estimateGrokOutputTokens(text) : 0
  if (!text || outputTokens <= 0) {
    return undefined
  }
  return {
    messageId: `grok:${timing.startedAt}`,
    model: text.model,
    outputTokens,
    generationMs: timing.endedAt - timing.startedAt,
    completedAt: timing.endedAt,
    estimated: true
  }
}
