// Feeds the open-tab search module from the store for a single worktree.

import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchAgentState,
  selectOpenTabSearchEntryState
} from './open-tab-search-entries'
import { searchOpenTabs, type OpenTabSearchResult } from './open-tab-search'

const EMPTY_RESULTS: OpenTabSearchResult[] = []

export type UseOpenTabSearchOptions = {
  enabled: boolean
  query: string
  worktreeId: string
}

export type OpenTabSearchSnapshot = {
  /** The query `results` describe; lags the requested query while deferred. */
  query: string
  results: OpenTabSearchResult[]
}

export function useOpenTabSearch({
  enabled,
  query,
  worktreeId
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

  return useMemo(
    () => ({
      query: deferredQuery,
      results: entries ? searchOpenTabs({ ...entries, query: deferredQuery }) : EMPTY_RESULTS
    }),
    [deferredQuery, entries]
  )
}
