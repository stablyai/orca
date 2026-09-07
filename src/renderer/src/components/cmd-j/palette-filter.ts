import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { getVisibleWorkspaceHostIdSet } from '../sidebar/visible-worktree-host-scope'
import { resolveWorktreeFilterHostId, type PaletteFilterModel } from './palette-filter-options'

export type PaletteFilterField = 'host' | 'repository'

/**
 * Sorted arrays rather than Sets: identity is stable across renders and the
 * serialized form is a cheap memo dependency for the palette's search passes.
 */
export type PaletteFilterState = {
  hostIds: readonly string[]
  repoIds: readonly string[]
}

export const EMPTY_PALETTE_FILTER: PaletteFilterState = { hostIds: [], repoIds: [] }

export function isPaletteFilterActive(filter: PaletteFilterState): boolean {
  return filter.hostIds.length > 0 || filter.repoIds.length > 0
}

export function getPaletteFilterSelectionCount(filter: PaletteFilterState): number {
  return filter.hostIds.length + filter.repoIds.length
}

function toggleValue(values: readonly string[], id: string): readonly string[] {
  if (values.includes(id)) {
    return values.filter((value) => value !== id)
  }
  return [...values, id].sort()
}

export function togglePaletteFilterValue(
  filter: PaletteFilterState,
  field: PaletteFilterField,
  id: string
): PaletteFilterState {
  return field === 'host'
    ? { ...filter, hostIds: toggleValue(filter.hostIds, id) }
    : { ...filter, repoIds: toggleValue(filter.repoIds, id) }
}

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
  const values = field === 'host' ? filter.hostIds : filter.repoIds
  const nextValues = addValues(values, ids)
  if (nextValues === values) {
    return filter
  }
  return field === 'host' ? { ...filter, hostIds: nextValues } : { ...filter, repoIds: nextValues }
}

export function clearPaletteFilterField(
  filter: PaletteFilterState,
  field: PaletteFilterField
): PaletteFilterState {
  if ((field === 'host' ? filter.hostIds : filter.repoIds).length === 0) {
    return filter
  }
  return field === 'host' ? { ...filter, hostIds: [] } : { ...filter, repoIds: [] }
}

type SidebarScopeForPaletteFilter = Parameters<typeof getVisibleWorkspaceHostIdSet>[0] & {
  filterRepoIds: readonly string[]
}

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
  return { hostIds, repoIds }
}

export type PaletteFilterPredicate = {
  matchesWorktree: (worktree: Pick<Worktree, 'repoId' | 'hostId'>) => boolean
  /** Keyed on the row, not a repo: one project row can span repos on several hosts. */
  matchesProjectRowKey: (rowKey: string) => boolean
  /** Project-group rows carry their own host stamp and belong to no single repo. */
  matchesGroupHostId: (hostId: ExecutionHostId) => boolean
}

/**
 * Returns null when no filter is active so callers can skip the pass entirely
 * rather than paying an identity-predicate call per row.
 */
export function buildPaletteFilterPredicate(
  filter: PaletteFilterState,
  model: PaletteFilterModel
): PaletteFilterPredicate | null {
  if (!isPaletteFilterActive(filter)) {
    return null
  }

  const selectedHostIds = filter.hostIds.length > 0 ? new Set(filter.hostIds) : null
  const selectedRepoIds = filter.repoIds.length > 0 ? new Set(filter.repoIds) : null
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
    matchesProjectRowKey: (rowKey) => {
      const rowRepoIds = model.repoIdsByProjectKey.get(rowKey) ?? []
      return rowRepoIds.some(
        (repoId) =>
          (!selectedRepoIds || selectedRepoIds.has(repoId)) && repoMatchesSelectedHost(repoId)
      )
    },
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
    matchesGroupHostId: (hostId) =>
      selectedRepoIds === null && (!selectedHostIds || selectedHostIds.has(hostId))
  }
}
