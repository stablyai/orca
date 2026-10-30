import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { getVisibleWorkspaceHostIdSet } from '../sidebar/visible-worktree-host-scope'
import { resolveWorktreeFilterHostId, type PaletteFilterModel } from './palette-filter-options'

export type PaletteFilterField = 'host' | 'repository'

/** Sorted arrays keep identity and serialized memo dependencies stable across renders. */
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

/** Return null for inactive filtering so callers can skip per-row predicate calls. */
export function buildPaletteFilterPredicate(
  filter: PaletteFilterState,
  model: PaletteFilterModel
): PaletteFilterPredicate | null {
  if (!isPaletteFilterActive(filter)) {
    return null
  }

  // Why expand: a merged host row matches workspaces owned by either of its ids.
  const selectedHostIds =
    filter.hostIds.length > 0
      ? new Set(
          filter.hostIds.flatMap((hostId) => [
            hostId,
            ...(model.equivalentHostIdsById?.get(hostId) ?? [])
          ])
        )
      : null
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
      // A worktree’s host stamp overrides its repo; runtime-owned workspaces can live elsewhere.
      return selectedHostIds.has(
        resolveWorktreeFilterHostId(worktree, model.repoById, model.defaultHostId)
      )
    },
    // Group headers belong to no repository; only host-only filters may retain them.
    matchesGroupHostId: (hostId) =>
      selectedRepoIds === null && (!selectedHostIds || selectedHostIds.has(hostId))
  }
}
