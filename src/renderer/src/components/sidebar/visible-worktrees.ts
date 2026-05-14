import type { Worktree, Repo, Tab, TerminalTab } from '../../../../shared/types'
import { buildWorktreeComparator, sortWorktreesSmart } from './smart-sort'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'

/**
 * Whether a worktree represents the repo's default-branch row that the
 * "Hide Default Branch Workspace" setting targets. Folder-mode projects are
 * main worktrees with branch === '' and are intentionally preserved.
 *
 * Why a shared helper: this predicate gates visibility in both the sidebar
 * pipeline (computeVisibleWorktreeIds) and the Cmd+J jump palette. Keeping
 * the definition in one place prevents the two surfaces from drifting.
 */
export function isDefaultBranchWorkspace(worktree: Worktree): boolean {
  return worktree.isMainWorktree && worktree.branch.trim() !== ''
}

/** Inputs describing every sidebar filter that can leave the list empty. */
export type SidebarFilterState = {
  showActiveOnly: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No worktrees found" message with no in-sidebar recovery path.
 */
export function sidebarHasActiveFilters(state: SidebarFilterState): boolean {
  return state.showActiveOnly || state.filterRepoIds.length > 0 || state.hideDefaultBranchWorkspace
}

/** Describes which mutators the Clear Filters button must invoke, separated
 *  from the mutators themselves so the decision logic is testable. */
export type ClearFilterActions = {
  resetShowActiveOnly: boolean
  resetFilterRepoIds: boolean
  resetHideDefaultBranchWorkspace: boolean
}

/**
 * Determines which sidebar filters the Clear Filters button needs to reset.
 * Returning an explicit action plan (rather than just calling the setters)
 * keeps the pure decision separate from the impure mutations, so tests can
 * verify the logic without mounting the component.
 *
 * Why reset only the ones that are set: keeps Clear Filters from churning
 * UI state (and the debounced ui.set write-back) on every click when the
 * flag was already off.
 */
export function computeClearFilterActions(state: SidebarFilterState): ClearFilterActions {
  return {
    resetShowActiveOnly: state.showActiveOnly,
    resetFilterRepoIds: state.filterRepoIds.length > 0,
    resetHideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace
  }
}

/**
 * Shared pure utility that computes the ordered list of visible (non-archived,
 * non-filtered) worktree IDs. Both the App-level Cmd+1–9 handler and
 * WorktreeList's render pipeline consume this function so the numbering and
 * card order can never diverge.
 *
 * Why a shared function: if the filter/sort pipeline lived in two places, a
 * new filter added in one but not the other would silently break the mapping
 * between badge numbers and the Cmd+N shortcut target.
 */
export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: {
    filterRepoIds: string[]
    showActiveOnly: boolean
    tabsByWorktree: Record<string, TerminalTab[]> | null
    ptyIdsByTabId: Record<string, string[]> | null
    unifiedTabsByWorktree?: Record<string, Tab[]> | null
    browserTabsByWorktree?: Record<string, { id: string }[]> | null
    activeWorktreeId?: string | null
    // Why required: every caller (WorktreeList, getVisibleWorktreeIds
    // fallback, tests) reads the flag from the UI store. Making the field
    // required prevents a future caller from silently dropping the filter by
    // forgetting to pass it.
    hideDefaultBranchWorkspace: boolean
    repoMap: Map<string, Repo>
  }
): string[] {
  let all: Worktree[] = getAllWorktreesFromState({ worktreesByRepo })

  // Filter archived
  all = all.filter((w) => !w.isArchived)

  if (opts.hideDefaultBranchWorkspace) {
    all = all.filter((w) => !isDefaultBranchWorkspace(w))
  }

  // Filter by repo
  if (opts.filterRepoIds.length > 0) {
    const selectedRepoIds = new Set(opts.filterRepoIds)
    all = all.filter((w) => selectedRepoIds.has(w.repoId))
  }

  // Filter active only
  if (opts.showActiveOnly) {
    all = all.filter((w) => {
      const tabs = opts.tabsByWorktree?.[w.id] ?? []
      const hasLiveTerminal = tabs.some((tab) =>
        opts.ptyIdsByTabId ? tabHasLivePty(opts.ptyIdsByTabId, tab.id) : false
      )
      const hasBrowserTabs = (opts.browserTabsByWorktree?.[w.id] ?? []).length > 0
      const hasNotesTabs = (opts.unifiedTabsByWorktree?.[w.id] ?? []).some(
        (tab) => tab.contentType === 'notes'
      )
      // Why: "Active only" should reflect the surfaces Orca can actually
      // restore into, not just PTY-backed terminals. A browser-tab worktree is
      // still active from the user's point of view even if it has no live PTY.
      // Project notes follow the same rule because they are workspace tabs
      // backed by the notes store, not PTY-backed terminal state.
      return hasLiveTerminal || hasBrowserTabs || hasNotesTabs || opts.activeWorktreeId === w.id
    })
  }

  // Apply cached sort order. Items not yet in the cache (e.g. brand-new
  // worktrees before the next sortEpoch bump) are appended at the end.
  const orderIndex = new Map(sortedIds.map((id, i) => [id, i]))
  all.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Infinity
    const bi = orderIndex.get(b.id) ?? Infinity
    return ai - bi
  })

  return all.map((w) => w.id)
}

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
 */
let _cachedVisibleIds: string[] = []

/**
 * Called by WorktreeList after computing visible worktrees so the Cmd+1–9
 * handler can read the exact same ordering the user sees on screen.
 */
export function setVisibleWorktreeIds(ids: string[]): void {
  _cachedVisibleIds = ids
}

/**
 * Compute the visible worktree IDs on-demand from the current Zustand store
 * state. Called by the App-level Cmd+1–9 handler (not a React hook — reads
 * store snapshot at call time).
 *
 * If WorktreeList has rendered at least once, returns the cached IDs so the
 * shortcut numbering matches the sidebar. Falls back to a live recomputation
 * only before WorktreeList's first render (e.g. app startup).
 */
export function getVisibleWorktreeIds(): string[] {
  // Prefer the cached IDs that mirror the rendered sidebar order.
  if (_cachedVisibleIds.length > 0) {
    return _cachedVisibleIds
  }

  // Fallback: live recomputation for the window before WorktreeList renders.
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
      state.ptyIdsByTabId
    ).map((w) => w.id)
  } else {
    // Why empty map: non-smart branches don't read attentionByWorktree, but
    // the param is required to keep smart-mode callers honest at the type level.
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(state.sortBy, repoMap, Date.now(), new Map())
    )
    sortedIds = sorted.map((w) => w.id)
  }

  return computeVisibleWorktreeIds(state.worktreesByRepo, sortedIds, {
    filterRepoIds: state.filterRepoIds,
    showActiveOnly: state.showActiveOnly,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    browserTabsByWorktree: state.browserTabsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    hideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    repoMap
  })
}
