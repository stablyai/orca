import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'
import type { AppState } from '@/store/types'
import { matchesSearch } from './worktree-list-groups'
import { buildWorktreeComparator } from './smart-sort'
import { useAppStore } from '@/store'

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
    searchQuery: string
    showActiveOnly: boolean
    tabsByWorktree: Record<string, TerminalTab[]> | null
    repoMap: Map<string, Repo>
    prCache: AppState['prCache'] | null
    issueCache: AppState['issueCache'] | null
  }
): string[] {
  let all: Worktree[] = Object.values(worktreesByRepo).flat()

  // Filter archived
  all = all.filter((w) => !w.isArchived)

  // Filter by repo
  if (opts.filterRepoIds.length > 0) {
    const selectedRepoIds = new Set(opts.filterRepoIds)
    all = all.filter((w) => selectedRepoIds.has(w.repoId))
  }

  // Filter by search — matches against displayName, branch, repo, comment,
  // PR number/title, and issue number/title (see matchesSearch).
  if (opts.searchQuery) {
    const q = opts.searchQuery.toLowerCase()
    all = all.filter((w) => matchesSearch(w, q, opts.repoMap, opts.prCache, opts.issueCache))
  }

  // Filter active only
  if (opts.showActiveOnly) {
    all = all.filter((w) => {
      const tabs = opts.tabsByWorktree?.[w.id] ?? []
      return tabs.some((t) => t.ptyId)
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
 * Compute the visible worktree IDs on-demand from the current Zustand store
 * state. Called by the App-level Cmd+1–9 handler (not a React hook — reads
 * store snapshot at call time).
 *
 * Why compute sort order here: WorktreeList caches sortedIds in a useMemo and
 * uses a sessionHasHadPty latch for cold-start detection. This function
 * approximates the same logic by checking if any live PTY exists. The only
 * divergence is the edge case where a user closes ALL terminals mid-session
 * (latch stays true in WorktreeList, but this check sees no PTYs). In
 * practice the persisted sortOrder is close to the live order so the
 * mismatch is negligible.
 */
export function getVisibleWorktreeIds(): string[] {
  const state = useAppStore.getState()
  const allWorktrees: Worktree[] = Object.values(state.worktreesByRepo)
    .flat()
    .filter((w) => !w.isArchived)

  let sortedIds: string[]

  if (state.sortBy === 'recent') {
    const hasAnyLivePty = Object.values(state.tabsByWorktree)
      .flat()
      .some((t) => t.ptyId)

    if (!hasAnyLivePty) {
      // Cold start: use persisted sortOrder snapshot
      const sorted = [...allWorktrees].sort(
        (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
      )
      sortedIds = sorted.map((w) => w.id)
    } else {
      const repoMap = new Map(state.repos.map((r) => [r.id, r]))
      const sorted = [...allWorktrees].sort(
        buildWorktreeComparator(
          state.sortBy,
          state.tabsByWorktree,
          repoMap,
          state.prCache,
          Date.now()
        )
      )
      sortedIds = sorted.map((w) => w.id)
    }
  } else {
    const repoMap = new Map(state.repos.map((r) => [r.id, r]))
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(
        state.sortBy,
        state.tabsByWorktree,
        repoMap,
        state.prCache,
        Date.now()
      )
    )
    sortedIds = sorted.map((w) => w.id)
  }

  const repoMap = new Map(state.repos.map((r) => [r.id, r]))
  return computeVisibleWorktreeIds(state.worktreesByRepo, sortedIds, {
    filterRepoIds: state.filterRepoIds,
    searchQuery: state.searchQuery,
    showActiveOnly: state.showActiveOnly,
    tabsByWorktree: state.tabsByWorktree,
    repoMap,
    prCache: state.prCache,
    issueCache: state.issueCache
  })
}
