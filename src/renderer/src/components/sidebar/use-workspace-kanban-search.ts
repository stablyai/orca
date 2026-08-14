import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { matchWorkspaceBoardWorktrees } from './workspace-kanban-search'

function areWorktreeIdSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

export function useWorkspaceKanbanSearch(args: {
  open: boolean
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
}): {
  query: string
  setQuery: (query: string) => void
  clearQuery: () => void
  matchingWorktreeIds: ReadonlySet<string> | null
  hasQuery: boolean
  /** True when the query was discarded for exceeding the palette byte bound. */
  isQueryTooLarge: boolean
} {
  const [query, setQuery] = useState('')
  // Why: board identities churn on agent-status ticks, so an unchanged match set
  // must keep its identity or every memoized card re-renders on every tick.
  // Store via setState-during-render (not a ref write) so discarded renders do
  // not leak a match set that never committed.
  const [stableMatched, setStableMatched] = useState<ReadonlySet<string> | null>(null)

  // Why: a stale query silently hiding cards on reopen is a trap. Reset during
  // render like useWorkspaceKanbanSelection, so no frame paints the old filter.
  if (!args.open && query !== '') {
    setQuery('')
  }

  // Why: the input stays fully controlled and undebounced, but a query change
  // mounts or unmounts every hidden card — clearing one costs about what opening
  // the board costs. Deferring only the filter keeps the caret responsive and
  // lets React interrupt the board re-render.
  const deferredQuery = useDeferredValue(query)

  const matched = useMemo(
    () =>
      matchWorkspaceBoardWorktrees({
        worktrees: args.worktrees,
        query: deferredQuery,
        repoMap: args.repoMap
      }),
    [args.repoMap, args.worktrees, deferredQuery]
  )

  const matchingWorktreeIds =
    stableMatched && matched && areWorktreeIdSetsEqual(stableMatched, matched)
      ? stableMatched
      : matched
  if (matchingWorktreeIds !== stableMatched) {
    setStableMatched(matchingWorktreeIds)
  }

  const clearQuery = useCallback(() => setQuery(''), [])

  return {
    query,
    setQuery,
    clearQuery,
    matchingWorktreeIds,
    // Why: an over-bound query is non-empty but non-filtering, and the lane
    // counts must not switch to "n / m" for it.
    hasQuery: matchingWorktreeIds !== null,
    // Why: whitespace-only text is also non-filtering, but it is self-evidently
    // so. A discarded 2KB paste looks identical to a query that matched
    // everything, so only that case earns an explanation. Read the deferred
    // query, not the live one — this describes the board, so it has to change
    // on the same frame the board does.
    isQueryTooLarge: isWorktreePaletteQueryTooLarge(deferredQuery)
  }
}
