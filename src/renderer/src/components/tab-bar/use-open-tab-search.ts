// Feeds the open-tab search module from the store for a single worktree.

import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchAgentState,
  selectOpenTabSearchEntryState,
  type OpenTabSearchEntries
} from './open-tab-search-entries'
import {
  capOpenTabSearchCandidates,
  searchOpenTabCandidates,
  type OpenTabSearchResult
} from './open-tab-search'
import { usePaletteSearchEvaluationContext } from '@/hooks/use-palette-search-evaluation-context'

const EMPTY_RESULTS: OpenTabSearchResult[] = []

export type UseOpenTabSearchOptions = {
  enabled: boolean
  query: string
  worktreeId: string
  /** Keyboard-selected result's `id`; keep it inside the display cap while it still matches. */
  retainedResultId?: string | null
}

export type OpenTabSearchSnapshot = {
  /** The query `results` describe; lags the requested query while deferred. */
  query: string
  results: OpenTabSearchResult[]
  /** What `results` were searched from, so a caller can re-check a newer query. */
  entries: OpenTabSearchEntries | null
}

export function useOpenTabSearch({
  enabled,
  query,
  worktreeId,
  retainedResultId
}: UseOpenTabSearchOptions): OpenTabSearchSnapshot {
  // Why null while disabled: a closed menu stays stable across store churn.
  const state = useAppStore(
    useShallow((store) => (enabled ? selectOpenTabSearchEntryState(store, worktreeId) : null))
  )
  // Why snapshot: agent status is a high-frequency stream; tab search metadata
  // stays stable while the menu is open and refreshes when its tab set changes.
  const agentState = useMemo(
    () => (enabled ? selectOpenTabSearchAgentState(useAppStore.getState()) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Refresh on open or tab-set changes, never agent-status churn.
    [enabled, state?.tabsByWorktree, state?.unifiedTabsByWorktree, worktreeId]
  )
  const entries = useMemo(
    () => (state && agentState ? buildOpenTabSearchEntries(state, agentState) : null),
    [agentState, state]
  )
  const deferredQuery = useDeferredValue(query)
  const evaluationSnapshot = useMemo(
    () => ({ deferredQuery, enabled, entries }),
    [deferredQuery, enabled, entries]
  )
  const context = usePaletteSearchEvaluationContext(evaluationSnapshot)
  const candidates = useMemo(
    () =>
      entries
        ? searchOpenTabCandidates({
            ...entries,
            query: deferredQuery,
            context
          })
        : EMPTY_RESULTS,
    [context, deferredQuery, entries]
  )

  return useMemo(
    () => ({
      query: deferredQuery,
      entries,
      results: capOpenTabSearchCandidates(candidates, retainedResultId)
    }),
    [candidates, deferredQuery, entries, retainedResultId]
  )
}
