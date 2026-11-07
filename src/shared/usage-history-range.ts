import type { UsageHistoryRange } from './usage-history-types'

export function localUsageDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function usageHistoryStartDay(range: UsageHistoryRange, now = new Date()): string | null {
  if (range === 'all') {
    return null
  }
  const cutoff = new Date(now)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (Number.parseInt(range, 10) - 1))
  return localUsageDay(cutoff)
}
