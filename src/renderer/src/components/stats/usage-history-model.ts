import {
  groupUsageHistory,
  type UsageHistoryTotals,
  type UsageHistoryGroup
} from '../../../../shared/usage-history-aggregation'
export {
  groupUsageHistory,
  totalUsageHistory,
  type UsageHistoryTotals,
  type UsageHistoryGroup
} from '../../../../shared/usage-history-aggregation'
import { localUsageDay, usageHistoryStartDay } from '../../../../shared/usage-history-range'
import type {
  UsageHistoryProvider,
  UsageHistoryRange,
  UsageHistoryRow
} from '../../../../shared/usage-history-types'

export type UsageHistorySelection = {
  range: UsageHistoryRange
  today?: string
  scope: 'all' | 'orca'
  provider: UsageHistoryProvider | 'all'
  account?: string | null
  model: string | null
  project: string | null
  day: string | null
}

export function filterUsageHistory(
  rows: readonly UsageHistoryRow[],
  selection: UsageHistorySelection,
  now = new Date()
): UsageHistoryRow[] {
  const calendar = selection.today ? new Date(`${selection.today}T12:00:00`) : now
  const startDay = usageHistoryStartDay(selection.range, calendar)
  const endDay = selection.today ?? (selection.range === 'all' ? null : localUsageDay(now))
  return rows.filter(
    (row) =>
      (!startDay || row.day >= startDay) &&
      (!endDay || row.day <= endDay) &&
      (selection.scope === 'all' || row.inOrca) &&
      (selection.provider === 'all' || row.provider === selection.provider) &&
      (selection.account == null || usageHistoryAccountKey(row) === selection.account) &&
      (selection.model === null || (row.model ?? 'unknown') === selection.model) &&
      (selection.project === null || row.projectKey === selection.project) &&
      (selection.day === null || row.day === selection.day)
  )
}

export function usageHistoryAccountKey(
  row: Pick<UsageHistoryRow, 'provider' | 'accountId'>
): string {
  return row.accountId ? JSON.stringify([row.provider, row.accountId]) : 'unknown'
}

export function formatCacheReadShare(
  totals: UsageHistoryTotals,
  locale = 'en-US',
  unavailable = 'n/a'
): string {
  const input = totals.newInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  if (input === 0) {
    return unavailable
  }
  const share = (totals.cacheReadTokens / input) * 100
  return share < 100 && share >= 99.95
    ? '<100%'
    : `${share.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

export function usageHistoryChartDays(
  rows: readonly UsageHistoryRow[],
  range: UsageHistoryRange,
  selectedDay: string | null,
  now = new Date(),
  today?: string
): { day: string; usage: UsageHistoryGroup | null }[] {
  const daily = groupUsageHistory(rows, 'day', '')
  const calendar = today ? new Date(`${today}T12:00:00`) : now
  const start = selectedDay ?? usageHistoryStartDay(range, calendar) ?? daily[0]?.key
  if (!start) {
    return []
  }
  const clientDay = localUsageDay(now)
  const lastDay = daily.at(-1)?.key ?? clientDay
  const end = selectedDay ?? today ?? (range === 'all' && lastDay > clientDay ? lastDay : clientDay)
  const byDay = new Map(daily.map((day) => [day.key, day]))
  const days: { day: string; usage: UsageHistoryGroup | null }[] = []
  const date = new Date(`${start}T00:00:00`)
  while (localUsageDay(date) <= end) {
    const day = localUsageDay(date)
    days.push({ day, usage: byDay.get(day) ?? null })
    date.setDate(date.getDate() + 1)
  }
  return days
}
