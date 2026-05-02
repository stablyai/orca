import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'
import { buildWorktreeComparator, sortWorktreesSmart } from './smart-sort'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'

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
    browserTabsByWorktree?: Record<string, { id: string }[]> | null
    activeWorktreeId?: string | null
    repoMap: Map<string, Repo>
  }
): string[] {
  let all: Worktree[] = getAllWorktreesFromState({ worktreesByRepo })

  // Filter archived
  all = all.filter((w) => !w.isArchived)

  // Filter by repo
  if (opts.filterRepoIds.length > 0) {
    const selectedRepoIds = new Set(opts.filterRepoIds)
    all = all.filter((w) => selectedRepoIds.has(w.repoId))
  }

  // Filter active only
  if (opts.showActiveOnly) {
    all = all.filter((w) => {
      const tabs = opts.tabsByWorktree?.[w.id] ?? []
      const hasLiveTerminal = tabs.some((t) => t.ptyId)
      const hasBrowserTabs = (opts.browserTabsByWorktree?.[w.id] ?? []).length > 0
      // Why: "Active only" should reflect the surfaces Orca can actually
      // restore into, not just PTY-backed terminals. A browser-tab worktree is
      // still active from the user's point of view even if it has no live PTY,
      // and the currently selected worktree should never vanish from the list.
      return hasLiveTerminal || hasBrowserTabs || opts.activeWorktreeId === w.id
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

  // Why: matches WorktreeList's gate — when the experimental agent-activity
  // feature is off, the agent-status map is not populated, so fall back to
  // the non-status sort heuristics instead of scoring against an empty map.
  const agentStatusForSort =
    state.settings?.experimentalAgentDashboard === true ? state.agentStatusByPaneKey : undefined
  if (state.sortBy === 'smart') {
    sortedIds = sortWorktreesSmart(
      allWorktrees,
      state.tabsByWorktree,
      repoMap,
      state.prCache,
      agentStatusForSort
    ).map((w) => w.id)
  } else {
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(
        state.sortBy,
        state.tabsByWorktree,
        repoMap,
        state.prCache,
        Date.now(),
        null,
        agentStatusForSort
      )
    )
    sortedIds = sorted.map((w) => w.id)
  }

  return computeVisibleWorktreeIds(state.worktreesByRepo, sortedIds, {
    filterRepoIds: state.filterRepoIds,
    showActiveOnly: state.showActiveOnly,
    tabsByWorktree: state.tabsByWorktree,
    browserTabsByWorktree: state.browserTabsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    repoMap
  })
}
