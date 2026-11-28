import type { PersistedUIState } from '../orca-profiles/persisted-ui-state-types'
import { compareCodePoints, createSidebarTextComparator } from '../sidebar-list/sorting/text-order'

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

/** Direct Smi (-1 | 0 | 1) descending recency comparison with create grace, avoiding HeapNumber return boxing. */
export function compareRecentActivityWithCreateGrace(
  aLastActivityAt: number,
  aCreatedAt: number | undefined,
  bLastActivityAt: number,
  bCreatedAt: number | undefined,
  now: number
): number {
  let recA = aLastActivityAt
  if (
    aCreatedAt !== undefined &&
    Number.isFinite(aCreatedAt) &&
    now < aCreatedAt + CREATE_GRACE_MS
  ) {
    const floorA = aCreatedAt + CREATE_GRACE_MS
    if (floorA > recA) {
      recA = floorA
    }
  }
  let recB = bLastActivityAt
  if (
    bCreatedAt !== undefined &&
    Number.isFinite(bCreatedAt) &&
    now < bCreatedAt + CREATE_GRACE_MS
  ) {
    const floorB = bCreatedAt + CREATE_GRACE_MS
    if (floorB > recB) {
      recB = floorB
    }
  }
  return recA > recB ? -1 : recA < recB ? 1 : 0
}

/** How one surface reads the sort keys from its own rows. */
export type WorkspaceRowSortReader<Row> = {
  label: (row: Row) => string
  /** Host-qualified id; breaks ties between rows whose labels are equal. */
  identity: (row: Row) => string
  repoLabel: (row: Row) => string
  /** Already floored by recentActivityWithCreateGrace. */
  recentActivity: (row: Row) => number
  /** Optional direct Smi comparator (-1 | 0 | 1) avoiding HeapNumber return boxing on epoch timestamps. */
  compareRecent?: (a: Row, b: Row) => number
  /** Higher ranks sort first; null sorts after every ranked row. */
  manualRank: (row: Row) => number | null
  /** Agent activity: the desktop ranks live agent attention, the phone the desktop's saved order. Ties fall to the label. */
  compareSmart: (a: Row, b: Row) => number
}

function compareDesc(a: number, b: number): number {
  return a > b ? -1 : a < b ? 1 : 0
}

function compareManualRank(a: number | null, b: number | null): number {
  if (a !== null && b !== null) {
    return compareDesc(a, b)
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
  switch (sortBy) {
    case 'name':
      return byLabel
    case 'smart':
      return (a, b) => read.compareSmart(a, b) || byLabel(a, b)
    case 'recent': {
      const compareRecent = read.compareRecent
      return compareRecent
        ? (a, b) => compareRecent(a, b) || byLabel(a, b)
        : (a, b) => compareDesc(read.recentActivity(a), read.recentActivity(b)) || byLabel(a, b)
    }
    case 'repo':
      return (a, b) => compareText(read.repoLabel(a), read.repoLabel(b)) || byLabel(a, b)
    case 'manual':
      return (a, b) => compareManualRank(read.manualRank(a), read.manualRank(b)) || byLabel(a, b)
  }
}
