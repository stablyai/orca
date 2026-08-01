// ─── Codex rollout token_count → context-occupancy reading ──────────────────
// Codex appends `event_msg`/`token_count` records to its rollout JSONL after
// each model response. `info.total_token_usage` is cumulative session spend
// (rebased on compaction/resume — see codex-usage/scanner.ts), so it can never
// stand in for context occupancy. `info.last_token_usage` describes the latest
// request: its `input_tokens` span the entire conversation prompt (cached
// tokens included — the scanner clamps cached ≤ input for the same reason), so
// occupancy = input + (output − reasoning); Codex drops reasoning from the next
// turn's context, mirroring its own tokens_in_context_window accounting.

import type { AgentContextUsage } from './agent-context-pressure'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * Context reading from one parsed rollout record, or undefined when the record
 * is not a usable `token_count`. Never fabricates: null-info rate-limit
 * snapshots and totals-only records (cumulative spend, not occupancy) yield no
 * reading. `maxTokens` comes from `info.model_context_window` when reported.
 */
export function readCodexRolloutContextUsage(
  record: Record<string, unknown>
): AgentContextUsage | undefined {
  if (record.type !== 'event_msg') {
    return undefined
  }
  const payload = asRecord(record.payload)
  if (payload?.type !== 'token_count') {
    return undefined
  }
  const info = asRecord(payload.info)
  const last = info ? asRecord(info.last_token_usage) : undefined
  if (!last) {
    return undefined
  }
  const inputTokens = tokenCount(last.input_tokens)
  if (inputTokens === undefined) {
    return undefined
  }
  const outputTokens = tokenCount(last.output_tokens) ?? 0
  const reasoningTokens = tokenCount(last.reasoning_output_tokens) ?? 0
  const usedTokens = inputTokens + Math.max(outputTokens - reasoningTokens, 0)
  const maxTokens = tokenCount(info?.model_context_window)
  return maxTokens !== undefined && maxTokens >= 1
    ? { usedTokens, maxTokens, providerId: 'openai' }
    : { usedTokens, providerId: 'openai' }
}
