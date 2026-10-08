import type { StructuredAgentContextUsage } from '../../../../shared/structured-agent-session-context-usage'

/** What the composer ring renders: the session's context usage with the
 *  provider's breakdown reduced to the rows worth showing. */
export type NativeChatContextUsageSummary = {
  usedTokens: number
  windowTokens: number
  percentage: number
  estimated: boolean
  /** Largest first, as a share of the window; empty rows are dropped. */
  rows: readonly { name: string; tokens: number; percentage: number }[]
}

function rowPercentage(tokens: number, windowTokens: number): number {
  return windowTokens > 0 ? Math.round((tokens / windowTokens) * 1000) / 10 : 0
}

export function summarizeContextUsage(
  usage: StructuredAgentContextUsage
): NativeChatContextUsageSummary {
  return {
    usedTokens: usage.usedTokens,
    windowTokens: usage.windowTokens,
    percentage: usage.percentage,
    estimated: usage.estimated,
    rows: usage.categories
      .filter((row) => row.tokens > 0)
      .map((row) => ({
        name: row.name,
        tokens: row.tokens,
        percentage: rowPercentage(row.tokens, usage.windowTokens)
      }))
      .sort((left, right) => right.tokens - left.tokens)
  }
}

/** `18.6k`, `981.4k`, `1M`: capital M, since a lowercase one reads as minutes. */
export function formatContextTokenCount(tokens: number): string {
  const safe = Math.max(0, tokens)
  // Compared after rounding, so 999,960 reads `1M` rather than `1000k`.
  if (Math.round(safe / 100) >= 10_000) {
    return `${trimZero((safe / 1_000_000).toFixed(1))}M`
  }
  if (safe >= 1_000) {
    return `${trimZero((safe / 1_000).toFixed(1))}k`
  }
  return String(Math.round(safe))
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
