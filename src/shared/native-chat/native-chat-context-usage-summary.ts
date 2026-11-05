import type { StructuredAgentContextUsage } from '../agent-session/structured-agent-session-context-usage'

/** Reduce provider context breakdowns to the rows shown by the composer ring. */
export type NativeChatContextUsageSummary = {
  usedTokens: number
  windowTokens: number
  percentage: number
  estimated: boolean
  /** Largest first, as a share of the window; empty rows are dropped. */
  rows: readonly { name: string; tokens: number; percentage: number }[]
}

/** Past this the window is nearly spent, so the ring turns red to say so. */
const CRITICAL_PERCENTAGE = 90

/** What a ring draws: its fill clamped to 0-100, the red state, and the token counts as shown. */
export function contextUsageRingReadout(usage: NativeChatContextUsageSummary): {
  filled: number
  critical: boolean
  used: string
  window: string
} {
  return {
    filled: Math.min(Math.max(usage.percentage, 0), 100),
    critical: usage.percentage >= CRITICAL_PERCENTAGE,
    used: formatContextTokenCount(usage.usedTokens),
    window: formatContextTokenCount(usage.windowTokens)
  }
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

/** The CLI can repeat a category name, so a row's key counts which repeat it is. */
export function keyContextUsageRows(
  rows: NativeChatContextUsageSummary['rows']
): { key: string; row: NativeChatContextUsageSummary['rows'][number] }[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const repeat = seen.get(row.name) ?? 0
    seen.set(row.name, repeat + 1)
    return { key: `${repeat}:${row.name}`, row }
  })
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
