export type { SidebarFilterState } from './sidebar-filter-actions'
export {
  computeVisibleWorktreeIds,
  computeVisibleWorktrees,
  type VisibleWorktreeOptions
} from './compute-visible-worktrees'
import { computeVisibleWorktreeIds } from './compute-visible-worktrees'
export { sidebarHasActiveFilters } from './sidebar-filter-actions'
import {
  getVisibleWorkspaceHostIdSet,
  worktreeMatchesVisibleHost
} from './visible-worktree-host-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import { sortWorktreesByStamps } from '../../../../shared/sidebar-list/smart-sort'
export {
  EMPTY_STRUCTURED_CHAT_WORKTREE_IDS,
  getWorktreeIdsWithStructuredChat
} from './visible-worktree-activity-inputs'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import {
  computeRenderedSidebarWorktreeOrder,
  computeRenderedSidebarWorktrees
} from './rendered-sidebar-worktree-order'

/**
 * Module-level cache of the visible worktree IDs as last computed by
 * WorktreeList's render pipeline.
 *
 * Why: WorktreeList holds its order while the pointer is over the list, so a
 * re-sort from a live Zustand snapshot could make the Cmd+1–9 shortcut target a
 * different worktree than what's rendered at that sidebar position. Caching the
 * IDs WorktreeList actually rendered keeps shortcut numbering on the card order.
 *
 * Why null vs []: [] is a real rendered order (everything collapsed/filtered);
 * null means WorktreeList is unmounted.
 */
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

export function getVisibleWorktreeIds(): string[] {
  // Prefer the published IDs that mirror the rendered sidebar order.
  if (_publishedVisibleIds) {
    return _publishedVisibleIds
  }

  const state = useAppStore.getState()
  const allWorktrees = getAllWorktreesFromState(state).filter((w) => !w.isArchived)

  const repoMap = getRepoMapFromState(state)

  const sortedIds = sortWorktreesByStamps([...allWorktrees], state.sortBy, repoMap).map((w) => w.id)

  const visibleIds = computeVisibleWorktreeIds(
    state.worktreesByRepo,
    sortedIds,
    buildVisibleWorktreeOptionsFromState(state, repoMap)
  )

  const visibleIdRank = new Map(visibleIds.map((id, index) => [id, index]))
  const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const visibleWorktrees = allWorktrees
    .filter(
      (worktree) =>
        visibleIdRank.has(worktree.id) &&
        worktreeMatchesVisibleHost(worktree, visibleHostIds, repoMap, defaultHostId)
    )
    .sort((a, b) => (visibleIdRank.get(a.id) ?? 0) - (visibleIdRank.get(b.id) ?? 0))
  // Why the row pipeline: grouping, pinning and main-worktree hoisting reorder cards, so a flat sort numbers the wrong workspace.
  return computeRenderedSidebarWorktreeOrder(state, visibleWorktrees)
}

export function getVisibleWorktreeShortcutTargets(): VisibleWorktreeShortcutTarget[] {
  if (_publishedVisibleShortcutTargets) {
    return _publishedVisibleShortcutTargets
  }
  const state = useAppStore.getState()
  const visibleIds = getVisibleWorktreeIds()
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
  return computeRenderedSidebarWorktrees(state, worktrees).map((worktree) => ({
    id: worktree.id,
    ...(worktree.hostId ? { executionHostId: worktree.hostId } : {})
  }))
}
