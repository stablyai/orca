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

// Rows follow the tab bar so a tab drag reorders the sidebar; rows without a current tab trail.
export function createTabBarAgentRowComparator(
  currentTabIds: ReadonlySet<string>
): (a: DashboardAgentRow, b: DashboardAgentRow) => number {
  const tabBarPosition = (row: DashboardAgentRow): number =>
    currentTabIds.has(row.tab.id) ? comparableNumber(row.tab.sortOrder) : Number.MAX_SAFE_INTEGER
  return (a, b) => tabBarPosition(a) - tabBarPosition(b) || compareWorktreeAgentRows(a, b)
}
