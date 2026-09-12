import type { ClaudeUsageDailyPoint } from '../../../../shared/claude-usage-types'
import type { UsageOverviewDailyPoint, UsageOverviewInput } from './usage-overview-types'

export function getClaudeDailyTotal(entry: ClaudeUsageDailyPoint): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

type UsageIntensity = 0 | 1 | 2 | 3 | 4

/**
 * Rank-based intensity: each non-zero level holds roughly a quarter of the
 * active days among `totals`, so callers rank exactly the set of days they
 * render. With fewer than four active days the lower levels go unused (one
 * active day is level 4, three distinct days are 2/3/4).
 *
 * Why: daily volume spans orders of magnitude across providers, so a linear
 * ramp against the single best day left most active days at the faintest
 * level and indistinguishable from idle ones.
 * @param totals - Token totals of every day, zero for idle days.
 * @returns Intensity per index of `totals`; idle days stay 0, the best day is 4.
 */
export function rankUsageIntensities(totals: number[]): UsageIntensity[] {
  const active = totals.filter((total) => total > 0).sort((left, right) => left - right)
  // Why: a value -> cumulative-count map keeps each lookup O(1); ties share the
  // higher rank (the last index written) so equal days never render differently.
  const countAtOrBelow = new Map<number, number>()
  for (let index = 0; index < active.length; index += 1) {
    countAtOrBelow.set(active[index], index + 1)
  }
  return totals.map((total) => {
    if (total <= 0) {
      return 0
    }
    const atOrBelow = countAtOrBelow.get(total) ?? 0
    return Math.max(1, Math.ceil((atOrBelow / active.length) * 4)) as UsageIntensity
  })
}

/**
 * Count distinct days in a list of `YYYY-MM-DD` keys.
 * @param days - Day keys, possibly repeated across providers.
 * @returns Number of distinct days.
 */
export function countActiveDays(days: string[]): number {
  return new Set(days).size
}

/**
 * Merge every provider's daily series into one per-day total with a rank intensity.
 * @param input - Per-provider scan state, summary, and daily series.
 * @returns One point per day, sorted ascending, ranked across all days present.
 */
export function buildDailyOverview(input: UsageOverviewInput): UsageOverviewDailyPoint[] {
  const byDay = new Map<string, Omit<UsageOverviewDailyPoint, 'intensity'>>()

  for (const entry of input.claude.daily) {
    const current = byDay.get(entry.day) ?? {
      day: entry.day,
      totalTokens: 0,
      claudeTokens: 0,
      codexTokens: 0,
      openCodeTokens: 0
    }
    const total = getClaudeDailyTotal(entry)
    current.totalTokens += total
    current.claudeTokens += total
    byDay.set(entry.day, current)
  }

  for (const entry of input.codex.daily) {
    const current = byDay.get(entry.day) ?? {
      day: entry.day,
      totalTokens: 0,
      claudeTokens: 0,
      codexTokens: 0,
      openCodeTokens: 0
    }
    current.totalTokens += entry.totalTokens
    current.codexTokens += entry.totalTokens
    byDay.set(entry.day, current)
  }

  for (const entry of input.opencode.daily) {
    const current = byDay.get(entry.day) ?? {
      day: entry.day,
      totalTokens: 0,
      claudeTokens: 0,
      codexTokens: 0,
      openCodeTokens: 0
    }
    current.totalTokens += entry.totalTokens
    current.openCodeTokens += entry.totalTokens
    byDay.set(entry.day, current)
  }

  const entries = [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
  const intensities = rankUsageIntensities(entries.map((entry) => entry.totalTokens))
  return entries.map((entry, index) => ({ ...entry, intensity: intensities[index] ?? 0 }))
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Pad a daily series to a fixed trailing window ending at `anchorDate`.
 * @param daily - Ranked daily points, any order.
 * @param dayCount - Number of trailing days to return.
 * @param anchorDate - Last day of the window; defaults to today.
 * @returns Exactly `dayCount` points, idle days filled with zero tokens and intensity 0.
 */
export function getRecentUsageDays(
  daily: UsageOverviewDailyPoint[],
  dayCount: number,
  anchorDate = new Date()
): UsageOverviewDailyPoint[] {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]))
  const count = Math.max(1, Math.floor(dayCount))
  const end = new Date(anchorDate)
  end.setHours(0, 0, 0, 0)

  const result: UsageOverviewDailyPoint[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(end)
    date.setDate(end.getDate() - offset)
    const day = formatLocalDay(date)
    result.push(
      byDay.get(day) ?? {
        day,
        totalTokens: 0,
        claudeTokens: 0,
        codexTokens: 0,
        openCodeTokens: 0,
        intensity: 0
      }
    )
  }
  return result
}
