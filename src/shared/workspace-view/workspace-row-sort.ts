import type { PersistedUIState } from '../persisted-ui-state-types'
import { compareCodePoints, createSidebarTextComparator } from '../sidebar-list/text-order'

export type WorkspaceSortBy = PersistedUIState['sortBy']

/** How one surface reads the sort keys from its own rows. */
export type WorkspaceRowSortReader<Row> = {
  label: (row: Row) => string
  /** Host-qualified id; breaks ties between rows whose labels are equal. */
  identity: (row: Row) => string
  repoLabel: (row: Row) => string
  recentActivity: (row: Row) => number
  /** Higher ranks sort first; null sorts after every ranked row. */
  manualRank: (row: Row) => number | null
  /** Agent activity by the owning host's stamps. Ties fall to the label. */
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
