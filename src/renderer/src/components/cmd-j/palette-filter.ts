import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { getVisibleWorkspaceHostIdSet } from '../sidebar/visible-worktree-host-scope'
import { resolveWorktreeFilterHostId, type PaletteFilterModel } from './palette-filter-options'

export type PaletteFilterField = 'host' | 'repository' | 'status'

/**
 * Sorted arrays rather than Sets: identity is stable across renders and the
 * serialized form is a cheap memo dependency for the palette's search passes.
 */
export type PaletteFilterState = {
  hostIds: readonly string[]
  repoIds: readonly string[]
  statusIds: readonly string[]
}

export const EMPTY_PALETTE_FILTER: PaletteFilterState = { hostIds: [], repoIds: [], statusIds: [] }

const filterKeyByField: Record<PaletteFilterField, keyof PaletteFilterState> = {
  host: 'hostIds',
  repository: 'repoIds',
  status: 'statusIds'
}

/** Treat any selected identity or session-status value as an active filter. */
export function isPaletteFilterActive(filter: PaletteFilterState): boolean {
  return filter.hostIds.length > 0 || filter.repoIds.length > 0 || filter.statusIds.length > 0
}

/** Count selected values across axes, not matching rows or active categories. */
export function getPaletteFilterSelectionCount(filter: PaletteFilterState): number {
  return filter.hostIds.length + filter.repoIds.length + filter.statusIds.length
}

/** Remove an existing ID or insert it in sorted order without mutating the input. */
function toggleValue(values: readonly string[], id: string): readonly string[] {
  if (values.includes(id)) {
    return values.filter((value) => value !== id)
  }
  return [...values, id].sort()
}

/** Toggle one axis while retaining the other axes' array identities. */
export function togglePaletteFilterValue(
  filter: PaletteFilterState,
  field: PaletteFilterField,
  id: string
): PaletteFilterState {
  const key = filterKeyByField[field]
  return { ...filter, [key]: toggleValue(filter[key], id) }
}

/** Merge unique IDs in sorted order, retaining the input reference on a no-op. */
function addValues(values: readonly string[], ids: readonly string[]): readonly string[] {
  if (ids.length === 0) {
    return values
  }
  const merged = new Set(values)
  const sizeBefore = merged.size
  for (const id of ids) {
    merged.add(id)
  }
  // Why: same reference when nothing was added keeps search memos stable.
  if (merged.size === sizeBefore) {
    return values
  }
  return [...merged].sort()
}

/** Bulk-add for "Select all matching"; de-dupes while preserving stable no-ops. */
export function addPaletteFilterValues(
  filter: PaletteFilterState,
  field: PaletteFilterField,
  ids: readonly string[]
): PaletteFilterState {
  const key = filterKeyByField[field]
  const values = filter[key]
  const nextValues = addValues(values, ids)
  if (nextValues === values) {
    return filter
  }
  return { ...filter, [key]: nextValues }
}

/** Clear the entire axis, preserving the filter reference when it is already empty. */
export function clearPaletteFilterField(
  filter: PaletteFilterState,
  field: PaletteFilterField
): PaletteFilterState {
  const key = filterKeyByField[field]
  if (filter[key].length === 0) {
    return filter
  }
  return { ...filter, [key]: [] }
}

type SidebarScopeForPaletteFilter = Parameters<typeof getVisibleWorkspaceHostIdSet>[0] & {
  filterRepoIds: readonly string[]
}

/** Normalize sidebar scope IDs into deterministic, duplicate-free selections. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** Seeds the palette from the sidebar's exact host and repository scope. */
export function buildPaletteFilterFromSidebarScope(
  scope: SidebarScopeForPaletteFilter
): PaletteFilterState {
  const visibleHostIds = getVisibleWorkspaceHostIdSet(scope)
  const hostIds = visibleHostIds ? sortedUnique(visibleHostIds) : []
  const repoIds = sortedUnique(scope.filterRepoIds)

  if (hostIds.length === 0 && repoIds.length === 0) {
    return EMPTY_PALETTE_FILTER
  }
  return { hostIds, repoIds, statusIds: [] }
}

export type PaletteFilterPredicate = {
  matchesWorktree: (worktree: Pick<Worktree, 'repoId' | 'hostId'>) => boolean
  /** Keyed on the row, not a repo: one project row can span repos on several hosts. */
  matchesProjectRowKey: (rowKey: string) => boolean
  /** Project-group rows carry their own host stamp and belong to no single repo. */
  matchesGroupHostId: (hostId: ExecutionHostId) => boolean
}

/**
 * Returns null when no host or repository filter is active so callers can skip
 * the identity pass entirely, including when only session status is filtered.
 */
export function buildPaletteFilterPredicate(
  filter: PaletteFilterState,
  model: PaletteFilterModel
): PaletteFilterPredicate | null {
  if (filter.hostIds.length === 0 && filter.repoIds.length === 0) {
    return null
  }

  const selectedHostIds = filter.hostIds.length > 0 ? new Set(filter.hostIds) : null
  const selectedRepoIds = filter.repoIds.length > 0 ? new Set(filter.repoIds) : null
  /** Match any host owning this repository, using the runtime default for unknown IDs. */
  const repoMatchesSelectedHost = (repoId: string): boolean => {
    if (!selectedHostIds) {
      return true
    }
    const repoHostIds = model.hostIdsByRepoId.get(repoId)
    if (!repoHostIds) {
      return selectedHostIds.has(model.defaultHostId)
    }
    for (const hostId of repoHostIds) {
      if (selectedHostIds.has(hostId)) {
        return true
      }
    }
    return false
  }

  return {
    /** Keep a project row when one represented repository satisfies both identity axes. */
    matchesProjectRowKey: (rowKey) => {
      const rowRepoIds = model.repoIdsByProjectKey.get(rowKey) ?? []
      return rowRepoIds.some(
        (repoId) =>
          (!selectedRepoIds || selectedRepoIds.has(repoId)) && repoMatchesSelectedHost(repoId)
      )
    },
    /** Match repository and effective worktree host together, independently of status. */
    matchesWorktree: (worktree) => {
      if (selectedRepoIds && !selectedRepoIds.has(worktree.repoId)) {
        return false
      }
      if (!selectedHostIds) {
        return true
      }
      // Why: worktree.hostId wins over the repo fallback — a runtime-owned
      // workspace can live on a different host than the repo it came from.
      return selectedHostIds.has(
        resolveWorktreeFilterHostId(worktree, model.repoById, model.defaultHostId)
      )
    },
    // Why: a group header has no repository, so a repository selection
    // excludes every group row; only the host axis can keep one.
    /** Admit repository-less group headers only when no repository constraint is active. */
    matchesGroupHostId: (hostId) =>
      selectedRepoIds === null && (!selectedHostIds || selectedHostIds.has(hostId))
  }
}
