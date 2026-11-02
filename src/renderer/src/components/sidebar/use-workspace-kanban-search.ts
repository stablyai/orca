import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { isWorktreePaletteQueryTooLarge } from '../../../../shared/palette-match/worktree-palette-query-bounds'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorkspaceBoardPaletteDocuments,
  matchWorkspaceBoardWorktrees
} from './workspace-kanban-search'

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
  // Commit equal match sets through state so cards keep stable identities without leaking discarded renders.
  const [stableMatched, setStableMatched] = useState<ReadonlySet<string> | null>(null)

  // Clear queries before painting a reopened board so stale filters cannot hide cards.
  if (!args.open && query !== '') {
    setQuery('')
  }

  // Defer expensive card filtering while keeping the input controlled and responsive.
  const deferredQuery = useDeferredValue(query)

  // Index changes depend on catalog inputs, not keystrokes; reuse normalized fields across queries.
  const documents = useMemo(
    () =>
      buildWorkspaceBoardPaletteDocuments({
        worktrees: args.worktrees,
        repoMap: args.repoMap
      }),
    [args.repoMap, args.worktrees]
  )

  const matched = useMemo(
    () =>
      matchWorkspaceBoardWorktrees({
        worktrees: args.worktrees,
        query: deferredQuery,
        repoMap: args.repoMap,
        documents
      }),
    [args.repoMap, args.worktrees, deferredQuery, documents]
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
    // An oversized query is ignored and must not display filtered lane counts.
    hasQuery: matchingWorktreeIds !== null,
    // Explain discarded oversized input on the same deferred frame as the board; whitespace needs no warning.
    isQueryTooLarge: isWorktreePaletteQueryTooLarge(deferredQuery)
  }
}
