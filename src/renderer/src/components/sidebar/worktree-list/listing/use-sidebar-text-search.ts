import { useMemo } from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { SidebarFeedIndex } from '../../../../../../shared/sidebar-list/feed/sidebar-feed-index'
import {
  didWorkspaceTextQueryHitLimit,
  EMPTY_COLLAPSED_GROUPS,
  filterWorktreesByTextQuery
} from './workspace-text-filter'

export type SidebarTextSearchableWorktree = Pick<
  Worktree,
  'displayName' | 'path' | 'branch' | 'repoId'
>

// Why one hook: the window model filters its store list while the main model
// filters its feed index, but the capped slice, the limit hint and the
// forced expansion stay identical across both list models.
export function useSidebarTextSearch<TWorktree extends SidebarTextSearchableWorktree>(
  worktrees: readonly TWorktree[],
  repoMap: ReadonlyMap<string, { displayName: string }>,
  textQuery: string | undefined,
  collapsedGroups: Set<string>
): {
  searchActive: boolean
  filteredWorktrees: TWorktree[]
  effectiveCollapsedGroups: Set<string>
  textSearchHitLimit: boolean
} {
  const query = textQuery ?? ''
  // Why session-local: dsh collapsed search never touches persisted filters.
  const searchActive = query.trim() !== ''
  const filteredWorktrees = useMemo(
    () => (searchActive ? filterWorktreesByTextQuery(worktrees, repoMap, query) : [...worktrees]),
    [worktrees, repoMap, query, searchActive]
  )
  // Why separate memo: the capped slice hides whether more rows matched.
  const textSearchHitLimit = useMemo(
    () => didWorkspaceTextQueryHitLimit(worktrees, repoMap, query),
    [worktrees, repoMap, query]
  )
  return {
    searchActive,
    filteredWorktrees,
    // Why dsh parity: search-result navigation expands every ancestor, so no
    // collapsed group may hide a match; stored collapses resume untouched.
    effectiveCollapsedGroups: searchActive ? EMPTY_COLLAPSED_GROUPS : collapsedGroups,
    textSearchHitLimit
  }
}

// Why split: the main model plans from a feed index, so the query narrows the
// plan's worktree set instead of a store list; folders stay untouched.
export function useSidebarTextSearchPlanIndex(
  index: SidebarFeedIndex,
  textQuery: string | undefined,
  collapsedGroups: Set<string>
): {
  planIndex: SidebarFeedIndex
  effectiveCollapsedGroups: Set<string>
  textSearchHitLimit: boolean
} {
  const textSearch = useSidebarTextSearch(
    index.worktrees,
    index.repoMap,
    textQuery,
    collapsedGroups
  )
  const planIndex = useMemo(
    () =>
      textSearch.searchActive && textSearch.filteredWorktrees.length !== index.worktrees.length
        ? { ...index, worktrees: [...textSearch.filteredWorktrees] }
        : index,
    [textSearch, index]
  )
  return {
    planIndex,
    effectiveCollapsedGroups: textSearch.effectiveCollapsedGroups,
    textSearchHitLimit: textSearch.textSearchHitLimit
  }
}
