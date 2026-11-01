import type { ExecutionHostId } from '../execution-host'
import type { PersistedUIState } from '../persisted-ui-state-types'
import {
  isHiddenByKindSwitch,
  type WorkspaceKind,
  type WorkspaceKindSwitches
} from '../worktree/workspace-kinds'

/** Persisted Workspace options filters shared across surfaces. */
export type WorkspaceRowFilters = WorkspaceKindSwitches & {
  hideSleepingWorkspaces: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep. Absent means on (#8873). */
  alwaysShowDefaultBranchWorkspace?: boolean
  hideWorkspacesFromOtherDevices: boolean
  filterRepoIds: readonly string[]
  /** The hosts shown; null shows every host. */
  visibleHostIds: readonly ExecutionHostId[] | null
}

/** Exhaustive mapping from each filter to its PersistedUIState field. */
export const WORKSPACE_ROW_FILTER_UI_FIELDS = {
  hideSleepingWorkspaces: 'hideSleepingWorkspaces',
  alwaysShowDefaultBranchWorkspace: 'alwaysShowDefaultBranchWorkspace',
  hideDefaultBranchWorkspace: 'hideDefaultBranchWorkspace',
  hideAutomationGeneratedWorkspaces: 'hideAutomationGeneratedWorkspaces',
  hideCliCreatedWorkspaces: 'hideCliCreatedWorkspaces',
  hideDetachedHeadWorkspaces: 'hideDetachedHeadWorkspaces',
  hideWorkspacesFromOtherDevices: 'hideWorkspacesFromOtherDevices',
  filterRepoIds: 'filterRepoIds',
  visibleHostIds: 'visibleWorkspaceHostIds'
} as const satisfies { [Key in keyof WorkspaceRowFilters]: keyof PersistedUIState }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the keys of a literal that satisfies a mapped type over WorkspaceRowFilters.
export const WORKSPACE_ROW_FILTER_KEYS = Object.keys(
  WORKSPACE_ROW_FILTER_UI_FIELDS
) as readonly (keyof WorkspaceRowFilters)[]

/** Every filter off, the default-branch exemption on, every project and host shown. */
export const NO_WORKSPACE_ROW_FILTERS: WorkspaceRowFilters = {
  hideSleepingWorkspaces: false,
  alwaysShowDefaultBranchWorkspace: true,
  hideDefaultBranchWorkspace: false,
  hideAutomationGeneratedWorkspaces: false,
  hideCliCreatedWorkspaces: false,
  hideDetachedHeadWorkspaces: false,
  hideWorkspacesFromOtherDevices: false,
  filterRepoIds: [],
  visibleHostIds: null
}

/** Desktop derives facts from worktrees/tabs; mobile reads host-stamped facts. Missing older-host facts read false to keep rows visible. */
export type WorkspaceRowFactReader<Row> = {
  isArchived: (row: Row) => boolean
  /** A folder workspace follows only the host and other-client filters (useSidebarHostVisibleScope). */
  isFolderWorkspace: (row: Row) => boolean
  repoId: (row: Row) => string
  /** Null when the row's host cannot be resolved; a host filter then hides it. */
  hostId: (row: Row) => ExecutionHostId | null
  isOtherClient: (row: Row) => boolean
  isDefaultBranch: (row: Row) => boolean
  isAutomationCreated: (row: Row) => boolean
  isCliCreated: (row: Row) => boolean
  isDetachedHead: (row: Row) => boolean
  isMainWorktree: (row: Row) => boolean
  isSleeping: (row: Row) => boolean
}

/** Exempt the main checkout from sleeping sweeps, including detached/offline mains that may be a project’s only entry point (#8873). */
export function isSleepingSweepExempt(
  isMainWorktree: boolean,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return alwaysShowDefaultBranchWorkspace !== false && isMainWorktree
}

const KIND_READERS: Record<
  WorkspaceKind,
  <Row>(read: WorkspaceRowFactReader<Row>, row: Row) => boolean
> = {
  defaultBranch: (read, row) => read.isDefaultBranch(row),
  automationCreated: (read, row) => read.isAutomationCreated(row),
  cliCreated: (read, row) => read.isCliCreated(row),
  detachedHead: (read, row) => read.isDetachedHead(row)
}

/** Build host/project sets once for the whole row filter pass. */
function buildWorkspaceRowPredicate<Row>(
  filters: WorkspaceRowFilters,
  read: WorkspaceRowFactReader<Row>
): (row: Row) => boolean {
  const repoIds = filters.filterRepoIds.length > 0 ? new Set(filters.filterRepoIds) : null
  const hostIds = filters.visibleHostIds ? new Set(filters.visibleHostIds) : null
  return (row) => {
    if (read.isArchived(row)) {
      return false
    }
    if (filters.hideWorkspacesFromOtherDevices && read.isOtherClient(row)) {
      return false
    }
    if (hostIds) {
      const hostId = read.hostId(row)
      if (hostId === null || !hostIds.has(hostId)) {
        return false
      }
    }
    if (read.isFolderWorkspace(row)) {
      return true
    }
    if (isHiddenByKindSwitch(filters, (kind) => KIND_READERS[kind](read, row))) {
      return false
    }
    if (repoIds && !repoIds.has(read.repoId(row))) {
      return false
    }
    // Explicit hides still win; the exemption covers only the sleeping sweep.
    return (
      !filters.hideSleepingWorkspaces ||
      isSleepingSweepExempt(read.isMainWorktree(row), filters.alwaysShowDefaultBranchWorkspace) ||
      !read.isSleeping(row)
    )
  }
}

/** The rows the Workspace options filters keep, in their given order. */
export function filterWorkspaceRows<Row>(
  rows: readonly Row[],
  filters: WorkspaceRowFilters,
  read: WorkspaceRowFactReader<Row>
): Row[] {
  return rows.filter(buildWorkspaceRowPredicate(filters, read))
}

/** The filters `target` sets differently from `current`; the exemption's absence means on. */
export function changedWorkspaceRowFilters(
  current: WorkspaceRowFilters,
  target: WorkspaceRowFilters
): Partial<WorkspaceRowFilters> {
  const changed: Partial<WorkspaceRowFilters> = {}
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    const from = comparableFilterValue(current, key)
    const to = comparableFilterValue(target, key)
    const same =
      Array.isArray(from) && Array.isArray(to)
        ? from.length === to.length && from.every((value, i) => value === to[i])
        : from === to
    if (!same) {
      Object.assign(changed, { [key]: target[key] })
    }
  }
  return changed
}

function comparableFilterValue(
  filters: WorkspaceRowFilters,
  key: keyof WorkspaceRowFilters
): WorkspaceRowFilters[keyof WorkspaceRowFilters] {
  return key === 'alwaysShowDefaultBranchWorkspace'
    ? filters.alwaysShowDefaultBranchWorkspace !== false
    : filters[key]
}

/** The filters set away from their defaults: what Clear filters resets. */
export function activeWorkspaceRowFilterKeys(
  filters: WorkspaceRowFilters
): (keyof WorkspaceRowFilters)[] {
  return WORKSPACE_ROW_FILTER_KEYS.filter(
    (key) => key in changedWorkspaceRowFilters(filters, NO_WORKSPACE_ROW_FILTERS)
  )
}

/** Pluralized "N filter(s)" for an options trigger's tooltip and accessibility label. */
export function formatActiveFilterLabel(count: number): string {
  return `${count} ${count === 1 ? 'filter' : 'filters'}`
}

/** The active-filter count as an options trigger's corner badge shows it. */
export function formatActiveFilterBadge(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/** Count narrowing filters plus selected known projects; stale repo IDs do not inflate the badge. */
export function countActiveWorkspaceFilters(
  filters: WorkspaceRowFilters,
  knownRepoIds: readonly string[]
): number {
  const counted = activeWorkspaceRowFilterKeys(filters).filter(
    (key) =>
      key !== 'filterRepoIds' &&
      // Disabling the exemption narrows only an active sleeping sweep.
      (key !== 'alwaysShowDefaultBranchWorkspace' || filters.hideSleepingWorkspaces)
  )
  const selectedRepoCount = knownRepoIds.filter((id) => filters.filterRepoIds.includes(id)).length
  return counted.length + selectedRepoCount
}
