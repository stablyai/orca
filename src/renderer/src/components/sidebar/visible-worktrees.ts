export type { SidebarFilterState } from './sidebar-filter-actions'
export {
  computeVisibleWorktreeIds,
  computeVisibleWorktrees,
  type VisibleWorktreeOptions
} from './compute-visible-worktrees'
import { computeVisibleWorktrees } from './compute-visible-worktrees'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
export { sidebarHasActiveFilters } from './sidebar-filter-actions'
import {
  getVisibleWorkspaceHostIdSet,
  worktreeMatchesVisibleHost
} from './visible-worktree-host-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeComparator,
  sortWorktreesSmart
} from '../../../../shared/sidebar-list/smart-sort'
export {
  EMPTY_STRUCTURED_CHAT_WORKTREE_IDS,
  getWorktreeIdsWithStructuredChat
} from './visible-worktree-activity-inputs'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import {
  computeRenderedSidebarWorktreeOrder,
  computeRenderedSidebarWorktrees
} from './rendered-sidebar-worktree-order'

/** Publish rendered order for shortcut parity; [] means no visible rows, null means the list is unmounted. */
let _publishedVisibleIds: string[] | null = null
export type VisibleWorktreeShortcutTarget = {
  id: string
  executionHostId?: Worktree['hostId']
  lineageGroupKey?: string
}
let _publishedVisibleShortcutTargets: VisibleWorktreeShortcutTarget[] | null = null

export function setVisibleWorktreeIds(ids: string[] | null): void {
  _publishedVisibleIds = ids
}

export function setVisibleWorktreeShortcutTargets(
  targets: VisibleWorktreeShortcutTarget[] | null
): void {
  _publishedVisibleShortcutTargets = targets
}

export function getPublishedVisibleWorktreeShortcutTargets():
  | readonly VisibleWorktreeShortcutTarget[]
  | null {
  return _publishedVisibleShortcutTargets
}

/** The unmounted list's visible rows in sidebar sort order, ranked per host copy like the mounted list. */
function computeUnmountedVisibleWorktrees(): Worktree[] {
  const state = useAppStore.getState()
  const allWorktrees = getAllWorktreesFromState(state).filter((w) => !w.isArchived)

  const repoMap = getRepoMapFromState(state)

  let sortedKeys: string[]

  if (state.sortBy === 'smart') {
    sortedKeys = sortWorktreesSmart(
      allWorktrees,
      state.tabsByWorktree,
      repoMap,
      state.agentStatusByPaneKey,
      state.runtimePaneTitlesByTabId,
      state.ptyIdsByTabId,
      state.migrationUnsupportedByPtyId,
      state.terminalLayoutsByTabId
    ).map(getWorktreeHostIdentity)
  } else {
    // Non-smart comparators ignore attention; the required argument protects smart-mode callers.
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(state.sortBy, repoMap, Date.now(), new Map())
    )
    sortedKeys = sorted.map(getWorktreeHostIdentity)
  }

  const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  return computeVisibleWorktrees(selectWorktreesByRepo(state), sortedKeys, {
    ...buildVisibleWorktreeOptionsFromState(state, repoMap),
    sortedByHostIdentity: true
  }).filter(
    (worktree) =>
      !worktree.isArchived &&
      worktreeMatchesVisibleHost(worktree, visibleHostIds, repoMap, defaultHostId)
  )
}

export function getVisibleWorktreeIds(): string[] {
  if (_publishedVisibleIds) {
    return _publishedVisibleIds
  }
  // Grouping, pinning and main-worktree hoisting must also govern shortcut numbering.
  return computeRenderedSidebarWorktreeOrder(
    useAppStore.getState(),
    computeUnmountedVisibleWorktrees()
  )
}

export function getVisibleWorktreeShortcutTargets(): VisibleWorktreeShortcutTarget[] {
  if (_publishedVisibleShortcutTargets) {
    return _publishedVisibleShortcutTargets
  }
  const state = useAppStore.getState()
  if (!_publishedVisibleIds) {
    return toShortcutTargets(
      computeRenderedSidebarWorktrees(state, computeUnmountedVisibleWorktrees())
    )
  }
  const visibleIds = _publishedVisibleIds
  const visibleIdRank = new Map(visibleIds.map((id, index) => [id, index]))
  const repoMap = getRepoMapFromState(state)
  const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const worktrees = getAllWorktreesFromState(state)
    .filter(
      (worktree) =>
        !worktree.isArchived &&
        visibleIdRank.has(worktree.id) &&
        worktreeMatchesVisibleHost(worktree, visibleHostIds, repoMap, defaultHostId)
    )
    .sort((a, b) => (visibleIdRank.get(a.id) ?? 0) - (visibleIdRank.get(b.id) ?? 0))
  return toShortcutTargets(computeRenderedSidebarWorktrees(state, worktrees))
}

function toShortcutTargets(worktrees: readonly Worktree[]): VisibleWorktreeShortcutTarget[] {
  return worktrees.map((worktree) => ({
    id: worktree.id,
    ...(worktree.hostId ? { executionHostId: worktree.hostId } : {})
  }))
}
