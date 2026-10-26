/** Keep input uncached; derive prompt totals with agentTurnUsagePromptTokens to avoid double-counting cache. */
export type AgentTurnUsage = {
  /** Provider input excluding cache reads and writes. */
  inputTokens: number
  outputTokens: number
  /** Cached input read during this turn, counted separately from inputTokens. */
  cacheReadTokens?: number
  /** Input written to cache during this turn, counted separately from inputTokens. */
  cacheWriteTokens?: number
  /** Turn wall time in milliseconds. */
  durationMs?: number
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function normalizeAgentTurnUsage(value: unknown): AgentTurnUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined
  }
  if (
    !('inputTokens' in value) ||
    !isTokenCount(value.inputTokens) ||
    !('outputTokens' in value) ||
    !isTokenCount(value.outputTokens)
  ) {
    return undefined
  }
  const cacheReadTokens = 'cacheReadTokens' in value ? value.cacheReadTokens : undefined
  const cacheWriteTokens = 'cacheWriteTokens' in value ? value.cacheWriteTokens : undefined
  const durationMs = 'durationMs' in value ? value.durationMs : undefined
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(isTokenCount(cacheReadTokens) ? { cacheReadTokens } : {}),
    ...(isTokenCount(cacheWriteTokens) ? { cacheWriteTokens } : {}),
    ...(isTokenCount(durationMs) ? { durationMs } : {})
  }
}

export function agentTurnUsageEqual(
  a: AgentTurnUsage | undefined,
  b: AgentTurnUsage | undefined
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.inputTokens === b.inputTokens &&
      a.outputTokens === b.outputTokens &&
      a.cacheReadTokens === b.cacheReadTokens &&
      a.cacheWriteTokens === b.cacheWriteTokens &&
      a.durationMs === b.durationMs)
  )
}

export function agentTurnUsagePromptTokens(usage: AgentTurnUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}
