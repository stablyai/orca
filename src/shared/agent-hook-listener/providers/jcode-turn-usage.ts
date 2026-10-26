import { normalizeAgentTurnUsage, type AgentTurnUsage } from '../../agent-turn-usage'

function parseCount(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
}

export function parseJcodeTurnUsage(
  hookPayload: Record<string, unknown>
): AgentTurnUsage | undefined {
  return normalizeAgentTurnUsage({
    inputTokens: parseCount(hookPayload.input_tokens),
    outputTokens: parseCount(hookPayload.output_tokens),
    cacheReadTokens: parseCount(hookPayload.cache_read_tokens),
    cacheWriteTokens: parseCount(hookPayload.cache_write_tokens),
    durationMs: parseCount(hookPayload.duration_ms)
  })
}
