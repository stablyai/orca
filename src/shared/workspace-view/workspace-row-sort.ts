import type { PersistedUIState } from '../persisted-ui-state-types'
import { compareCodePoints, createSidebarTextComparator } from '../sidebar-list/text-order'

export type WorkspaceSortBy = PersistedUIState['sortBy']

/** New workspaces get a createdAt + CREATE_GRACE_MS floor so ambient terminal activity cannot immediately bury them in Recent. */
export const CREATE_GRACE_MS = 5 * 60 * 1000

/** Apply the grace floor during its time window; non-finite timestamps receive none. */
export function recentActivityWithCreateGrace(
  lastActivityAt: number,
  createdAt: number | undefined,
  now: number
): number {
  if (
    createdAt === undefined ||
    !Number.isFinite(createdAt) ||
    now >= createdAt + CREATE_GRACE_MS
  ) {
    return lastActivityAt
  }
  return Math.max(lastActivityAt, createdAt + CREATE_GRACE_MS)
}

/** How one surface reads the sort keys from its own rows. */
export type WorkspaceRowSortReader<Row> = {
  label: (row: Row) => string
  /** Host-qualified id; breaks ties between rows whose labels are equal. */
  identity: (row: Row) => string
  repoLabel: (row: Row) => string
  /** Already floored by recentActivityWithCreateGrace. */
  recentActivity: (row: Row) => number
  /** Higher ranks sort first; null sorts after every ranked row. */
  manualRank: (row: Row) => number | null
  /** Agent activity: the desktop ranks live agent attention, the phone the desktop's saved order. Ties fall to the label. */
  compareSmart: (a: Row, b: Row) => number
}

function compareManualRank(a: number | null, b: number | null): number {
  if (a !== null && b !== null) {
    return b - a
  }
  if (a !== null) {
    return -1
  }
  return b !== null ? 1 : 0
}

export function buildWorkspaceRowComparator<Row>(
  sortBy: WorkspaceSortBy,
  read: WorkspaceRowSortReader<Row>
): (a: Row, b: Row) => number {
  const compareText = createSidebarTextComparator()
  const byLabel = (a: Row, b: Row): number =>
    compareText(read.label(a), read.label(b)) ||
    compareCodePoints(read.identity(a), read.identity(b))
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return byLabel(a, b)
      case 'smart':
        return read.compareSmart(a, b) || byLabel(a, b)
      case 'recent':
        return read.recentActivity(b) - read.recentActivity(a) || byLabel(a, b)
      case 'repo':
        return compareText(read.repoLabel(a), read.repoLabel(b)) || byLabel(a, b)
      case 'manual':
        return compareManualRank(read.manualRank(a), read.manualRank(b)) || byLabel(a, b)
    }
  }
}
