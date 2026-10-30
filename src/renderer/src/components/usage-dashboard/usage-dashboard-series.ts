import type { UsageProviderId } from '../stats/usage-overview-types'
import { formatLocalDay } from '../stats/usage-overview-daily-series'

/** One merged day for the drawer chart/footer; `reasoningTokens` is display-only (resolution 8). */
export type UsageDashboardDailyPoint = {
  day: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  costUsd: number
}

/** A provider's period-scoped model usage, normalized into the drawer's cache/total buckets. */
export type UsageDashboardModelRow = {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number | null
}

/** Provider model row normalized by `loadDashboardProviderData`; cost is optional per provider. */
export type UsageDashboardModelRowInput = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  costUsd?: number | null
}

type DashboardDailyProvider = {
  id: UsageProviderId
  daily: readonly UsageDashboardDailyPoint[]
}

type DashboardModelProvider = {
  id: UsageProviderId
  rows: readonly UsageDashboardModelRowInput[]
}

type DailyTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  hasReasoning: boolean
  costUsd: number
}

function toFinite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyTotals(): DailyTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    hasReasoning: false,
    costUsd: 0
  }
}

/**
 * Merge per-provider daily points into one series for the last `days` local days ending on
 * `anchorDate` (today by default), zero-filling days no provider reported.
 */
export function buildUsageDashboardDailySeries(
  providers: DashboardDailyProvider[],
  days: number,
  anchorDate = new Date()
): UsageDashboardDailyPoint[] {
  const byDay = new Map<string, DailyTotals>()

  for (const provider of providers) {
    for (const entry of provider.daily) {
      const current = byDay.get(entry.day) ?? emptyTotals()
      current.inputTokens += toFinite(entry.inputTokens)
      current.outputTokens += toFinite(entry.outputTokens)
      current.cacheReadTokens += toFinite(entry.cacheReadTokens)
      current.cacheWriteTokens += toFinite(entry.cacheWriteTokens)
      current.costUsd += toFinite(entry.costUsd)
      if (entry.reasoningTokens !== undefined) {
        current.reasoningTokens += toFinite(entry.reasoningTokens)
        current.hasReasoning = true
      }
      byDay.set(entry.day, current)
    }
  }

  const count = Math.max(1, Math.floor(days))
  const end = new Date(anchorDate)
  end.setHours(0, 0, 0, 0)

  const series: UsageDashboardDailyPoint[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(end)
    date.setDate(end.getDate() - offset)
    const day = formatLocalDay(date)
    const totals = byDay.get(day)
    series.push({
      day,
      inputTokens: totals?.inputTokens ?? 0,
      outputTokens: totals?.outputTokens ?? 0,
      cacheReadTokens: totals?.cacheReadTokens ?? 0,
      cacheWriteTokens: totals?.cacheWriteTokens ?? 0,
      ...(totals?.hasReasoning ? { reasoningTokens: totals.reasoningTokens } : {}),
      costUsd: totals?.costUsd ?? 0
    })
  }
  return series
}

/**
 * Flatten provider model breakdowns into table rows, sorted by total tokens desc. `totalTokens`
 * excludes reasoning tokens; `costUsd` stays null when the provider prices none of its rows.
 */
export function buildUsageDashboardModelRows(
  breakdowns: DashboardModelProvider[]
): UsageDashboardModelRow[] {
  const rows: UsageDashboardModelRow[] = []

  for (const breakdown of breakdowns) {
    for (const row of breakdown.rows) {
      const inputTokens = toFinite(row.inputTokens)
      const outputTokens = toFinite(row.outputTokens)
      const cacheReadTokens = toFinite(row.cacheReadTokens)
      const cacheWriteTokens = toFinite(row.cacheWriteTokens)
      rows.push({
        provider: breakdown.id,
        model: row.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: toFinite(row.reasoningTokens),
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        costUsd:
          typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null
      })
    }
  }

  return rows.sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model)
  )
}
