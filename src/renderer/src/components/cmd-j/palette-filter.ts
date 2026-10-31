import {
  projectFilterSelection,
  editProjectFilter
} from '../../../../shared/project-repo-filter-selection'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
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

export function getPaletteFilterSelectionCount(
  filter: PaletteFilterState,
  model?: PaletteFilterModel
): number {
  return (
    filter.hostIds.length +
    (model ? getPaletteProjectSelection(model, filter.repoIds).badgeCount : filter.repoIds.length)
  )
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
  id: string,
  model?: PaletteFilterModel
): PaletteFilterState {
  if (field === 'repository' && model) {
    return editPaletteProjectValues(
      filter,
      model,
      [id],
      getPaletteProjectSelection(model, filter.repoIds).full.has(id) ? 'remove' : 'complete'
    )
  }
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
  ids: readonly string[],
  model?: PaletteFilterModel
): PaletteFilterState {
  if (field === 'repository' && model) {
    return editPaletteProjectValues(filter, model, ids, 'complete')
  }
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
  const matchesRepo = projectRepoFilterMatcher(filter.repoIds)
  const repoMatchesSelectedHost = (repoId: string): boolean => {
    const hosts = model.hostIdsByRepoId.get(repoId)
    if (!hosts) {
      return (
        matchesRepo(repoId, model.defaultHostId) &&
        (!selectedHostIds || selectedHostIds.has(model.defaultHostId))
      )
    }
    for (const hostId of hosts) {
      if (matchesRepo(repoId, hostId) && (!selectedHostIds || selectedHostIds.has(hostId))) {
        return true
      }
    }
    return false
  }

  return {
    matchesProjectRowKey: (rowKey) => {
      const members = model.membersByProjectKey?.get(rowKey)
      if (members) {
        return members.some(
          (member) =>
            matchesRepo(member.repoId, member.hostId) &&
            (!selectedHostIds || selectedHostIds.has(member.hostId))
        )
      }
      const rowRepoIds = model.repoIdsByProjectKey.get(rowKey) ?? []
      return rowRepoIds.some(repoMatchesSelectedHost)
    },
    matchesWorktree: (worktree) => {
      if (
        !matchesRepo(
          worktree.repoId,
          resolveWorktreeFilterHostId(worktree, model.repoById, model.defaultHostId)
        )
      ) {
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

/** One projection serves menu, badge and chips; unknown saved tokens remain independently removable. */
export function getPaletteProjectSelection(model: PaletteFilterModel, ids: readonly string[]) {
  const known = model.projectIndex ? projectFilterSelection(model.projectIndex, ids) : null
  const full = new Set(known?.fullKeys ?? [])
  const partial = new Set(known?.partialKeys ?? [])
  const matching = new Set(known?.matchingKeys ?? [])
  const representedRawIds = new Set<string>()
  const matches = projectRepoFilterMatcher(ids)
  for (const option of model.repositories) {
    if (!ids.length || model.projectIndex?.groupByKey.has(option.id)) {
      continue
    }
    let total = 0
    let selected = 0
    const members = model.repoIdsByProjectKey.get(option.id) ?? []
    for (const id of members) {
      const hosts = model.hostIdsByRepoId.get(id)
      for (const host of hosts ?? [model.defaultHostId]) {
        total++
        if (matches(id, host)) {
          selected++
        }
      }
    }
    if (selected) {
      matching.add(option.id)
      ;(selected === total ? full : partial).add(option.id)
      for (const id of members) {
        representedRawIds.add(id)
      }
    }
  }
  const unresolved = (known?.unresolved ?? ids).filter(
    (id) => !representedRawIds.has(id.slice(id.indexOf('\0') + 1))
  )
  return { full, partial, matching, unresolved, badgeCount: matching.size + unresolved.length }
}

export function editPaletteProjectValues(
  filter: PaletteFilterState,
  model: PaletteFilterModel,
  keys: readonly string[],
  kind: 'complete' | 'remove'
): PaletteFilterState {
  const knownKeys = keys.filter((key) => model.projectIndex?.groupByKey.has(key))
  let repoIds: readonly string[] =
    model.projectIndex && knownKeys.length
      ? editProjectFilter(model.projectIndex, filter.repoIds, { kind, keys: knownKeys })
      : filter.repoIds
  const raw = new Set(
    keys
      .filter((key) => !model.projectIndex?.groupByKey.has(key))
      .flatMap((key) => model.repoIdsByProjectKey.get(key) ?? [key])
  )
  if (raw.size) {
    repoIds =
      kind === 'remove'
        ? repoIds.filter((id) => !raw.has(id.slice(id.indexOf('\0') + 1)))
        : [...new Set([...repoIds, ...raw])]
  }
  return { ...filter, repoIds }
}
