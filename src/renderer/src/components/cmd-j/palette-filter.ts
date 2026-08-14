import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  resolveRepoFilterHostId,
  resolveWorktreeFilterHostId,
  type PaletteFilterModel
} from './palette-filter-options'

export type PaletteFilterField = 'host' | 'project'

/**
 * Sorted arrays rather than Sets: identity is stable across renders and the
 * serialized form is a cheap memo dependency for the palette's search passes.
 */
export type PaletteFilterState = {
  hostIds: readonly string[]
  projectKeys: readonly string[]
}

export const EMPTY_PALETTE_FILTER: PaletteFilterState = { hostIds: [], projectKeys: [] }

/** Guard against a pathological selection blowing up the predicate's Set build. */
export const PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD = 500

export function isPaletteFilterActive(filter: PaletteFilterState): boolean {
  return filter.hostIds.length > 0 || filter.projectKeys.length > 0
}

export function getPaletteFilterSelectionCount(filter: PaletteFilterState): number {
  return filter.hostIds.length + filter.projectKeys.length
}

function toggleValue(values: readonly string[], id: string): readonly string[] {
  if (values.includes(id)) {
    return values.filter((value) => value !== id)
  }
  // Why: same reference on the capped no-op — a fresh array would invalidate
  // every downstream search memo for a click that changed nothing.
  if (values.length >= PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD) {
    return values
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
    : { ...filter, projectKeys: toggleValue(filter.projectKeys, id) }
}

function addValues(values: readonly string[], ids: readonly string[]): readonly string[] {
  if (ids.length === 0 || values.length >= PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD) {
    return values
  }
  const merged = new Set(values)
  const sizeBefore = merged.size
  for (const id of ids) {
    if (merged.size >= PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD) {
      break
    }
    merged.add(id)
  }
  // Why: same reference when nothing new fit — keeps search memos stable.
  if (merged.size === sizeBefore) {
    return values
  }
  return [...merged].sort()
}

/** Bulk-add for "Select all matching"; respects the per-field cap and de-dupes. */
export function addPaletteFilterValues(
  filter: PaletteFilterState,
  field: PaletteFilterField,
  ids: readonly string[]
): PaletteFilterState {
  return field === 'host'
    ? { ...filter, hostIds: addValues(filter.hostIds, ids) }
    : { ...filter, projectKeys: addValues(filter.projectKeys, ids) }
}

export function clearPaletteFilterField(
  filter: PaletteFilterState,
  field: PaletteFilterField
): PaletteFilterState {
  return field === 'host' ? { ...filter, hostIds: [] } : { ...filter, projectKeys: [] }
}

function pruneToAvailable(values: readonly string[], available: ReadonlySet<string>): string[] {
  return values.filter((value) => available.has(value))
}

/**
 * Drops selections whose host or project disappeared (repo removed, SSH target
 * deleted). Without this a stale id would silently empty the palette forever.
 * Returns the same reference when nothing changed so memo deps stay stable.
 */
export function reconcilePaletteFilter(
  filter: PaletteFilterState,
  model: PaletteFilterModel
): PaletteFilterState {
  if (!isPaletteFilterActive(filter)) {
    return filter
  }
  const hostIds = pruneToAvailable(filter.hostIds, new Set(model.hosts.map((host) => host.id)))
  const projectKeys = pruneToAvailable(
    filter.projectKeys,
    new Set(model.projects.map((project) => project.id))
  )
  if (
    hostIds.length === filter.hostIds.length &&
    projectKeys.length === filter.projectKeys.length
  ) {
    return filter
  }
  return { hostIds, projectKeys }
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
  const selectedProjectKeys = filter.projectKeys.length > 0 ? new Set(filter.projectKeys) : null
  let selectedRepoIds: Set<string> | null = null
  if (selectedProjectKeys) {
    selectedRepoIds = new Set<string>()
    for (const projectKey of selectedProjectKeys) {
      for (const repoId of model.repoIdsByProjectKey.get(projectKey) ?? []) {
        selectedRepoIds.add(repoId)
      }
    }
  }

  return {
    matchesProjectRowKey: (rowKey) => {
      if (selectedProjectKeys && !selectedProjectKeys.has(rowKey)) {
        return false
      }
      if (!selectedHostIds) {
        return true
      }
      // Why: the row survives if *any* of its repos is on a selected host — a
      // project checked out on both local and SSH is still reachable from either.
      return (model.repoIdsByProjectKey.get(rowKey) ?? []).some((repoId) =>
        selectedHostIds.has(
          resolveRepoFilterHostId(repoId, model.hostIdByRepoId, model.defaultHostId)
        )
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
        resolveWorktreeFilterHostId(worktree, model.hostIdByRepoId, model.defaultHostId)
      )
    },
    // Why: a group header is not a project, so an explicit project selection
    // excludes every group row; only the host axis can keep one.
    matchesGroupHostId: (hostId) =>
      selectedRepoIds === null && (!selectedHostIds || selectedHostIds.has(hostId))
  }
}
