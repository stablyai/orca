import type { ClaudeUsageDailyPoint } from '../../../../shared/claude-usage-types'
import type { UsageOverviewDailyPoint, UsageOverviewInput } from './usage-overview-types'

export function getClaudeDailyTotal(entry: ClaudeUsageDailyPoint): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

function getIntensity(totalTokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (totalTokens <= 0 || maxTokens <= 0) {
    return 0
  }
  const ratio = totalTokens / maxTokens
  if (ratio <= 0.25) {
    return 1
  }
  if (ratio <= 0.5) {
    return 2
  }
  if (ratio <= 0.75) {
    return 3
  }
  return 4
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

  let maxTokens = 0
  // Why: usage history can be large enough to exceed V8's argument limit if
  // every day is spread into Math.max.
  for (const entry of byDay.values()) {
    maxTokens = Math.max(maxTokens, entry.totalTokens)
  }
  return [...byDay.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((entry) => ({
      ...entry,
      intensity: getIntensity(entry.totalTokens, maxTokens)
    }))
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
