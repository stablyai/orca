import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

function comparableNumber(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function comparePaneKeysOrdinal(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

export function compareWorktreeAgentRows(a: DashboardAgentRow, b: DashboardAgentRow): number {
  return (
    comparableNumber(a.startedAt) - comparableNumber(b.startedAt) ||
    comparableNumber(a.tab.sortOrder) - comparableNumber(b.tab.sortOrder) ||
    comparableNumber(a.tab.createdAt) - comparableNumber(b.tab.createdAt) ||
    comparePaneKeysOrdinal(a.paneKey, b.paneKey)
  )
}
