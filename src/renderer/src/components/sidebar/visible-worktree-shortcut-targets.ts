import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { buildWorktreeComparator, sortWorktreesSmart } from './smart-sort'
// Runtime edge only one way: the builder imports VisibleWorktreeOptions as a type, which erases.
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import {
  getVisibleWorkspaceHostIdSet,
  worktreeMatchesVisibleHost
} from './visible-worktree-host-scope'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import {
  computeRenderedSidebarWorktreeOrder,
  computeRenderedSidebarWorktrees
} from './rendered-sidebar-worktree-order'
import { computeVisibleWorktreeIds } from './visible-worktrees'

/**
 * Module-level cache of the visible worktree IDs as last computed by
 * WorktreeList's render pipeline.
 *
 * Why: WorktreeList freezes its sort order via sortedIds / sortEpoch useMemo
 * and only re-sorts when sortEpoch bumps. If getVisibleWorktreeIds()
 * recomputes sort order from a live Zustand snapshot, the Cmd+1–9 shortcut
 * could target a different worktree than what's rendered at that sidebar
 * position. By caching the IDs that WorktreeList actually rendered, the
 * shortcut numbering always matches the sidebar card order.
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

  // Hoist repoMap so it's built once and reused across all branches below.
  const repoMap = getRepoMapFromState(state)

  let sortedIds: string[]

  if (state.sortBy === 'smart') {
    sortedIds = sortWorktreesSmart(
      allWorktrees,
      state.tabsByWorktree,
      repoMap,
      state.agentStatusByPaneKey,
      state.runtimePaneTitlesByTabId,
      state.ptyIdsByTabId,
      state.migrationUnsupportedByPtyId,
      state.terminalLayoutsByTabId
    ).map((w) => w.id)
  } else {
    // Why empty map: non-smart branches don't read attentionByWorktree, but
    // the param is required to keep smart-mode callers honest at the type level.
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(state.sortBy, repoMap, Date.now(), new Map())
    )
    sortedIds = sorted.map((w) => w.id)
  }

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
