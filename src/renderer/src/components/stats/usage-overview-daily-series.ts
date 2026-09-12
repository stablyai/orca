import type { ClaudeUsageDailyPoint } from '../../../../shared/claude-usage-types'
import type { UsageOverviewDailyPoint, UsageOverviewInput } from './usage-overview-types'

export function getClaudeDailyTotal(entry: ClaudeUsageDailyPoint): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

type UsageIntensity = 0 | 1 | 2 | 3 | 4

/**
 * Rank-based intensity: each non-zero level holds a quarter of the active days.
 *
 * Why: daily volume spans orders of magnitude across providers, so a linear
 * ramp against the single best day left most active days at the faintest
 * level and indistinguishable from idle ones.
 * @param totals - Token totals of every day, zero for idle days.
 * @returns Intensity per index of `totals`; idle days stay 0, the best day is 4.
 */
export function rankUsageIntensities(totals: number[]): UsageIntensity[] {
  const active = totals.filter((total) => total > 0).sort((left, right) => left - right)
  return totals.map((total) => {
    if (total <= 0) {
      return 0
    }
    // Ties share the higher rank so equal days never render differently.
    let atOrBelow = active.length
    while (atOrBelow > 0 && active[atOrBelow - 1] > total) {
      atOrBelow -= 1
    }
    return Math.max(1, Math.ceil((atOrBelow / active.length) * 4)) as UsageIntensity
  })
}

export function countActiveDays(days: string[]): number {
  return new Set(days).size
}

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
