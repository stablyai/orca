// Feeds the open-tab search module from the store for a single worktree.

import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildOpenTabSearchEntries, selectOpenTabSearchEntryState } from './open-tab-search-entries'
import { searchOpenTabs, type OpenTabSearchResult } from './open-tab-search'

const EMPTY_RESULTS: OpenTabSearchResult[] = []

export type UseOpenTabSearchOptions = {
  enabled: boolean
  query: string
  worktreeId: string
}

export function useOpenTabSearch({
  enabled,
  query,
  worktreeId
}: UseOpenTabSearchOptions): OpenTabSearchResult[] {
  // Why null while disabled: a closed menu stays stable across store churn.
  const state = useAppStore(
    useShallow((store) => (enabled ? selectOpenTabSearchEntryState(store, worktreeId) : null))
  )
  const entries = useMemo(() => (state ? buildOpenTabSearchEntries(state) : null), [state])
  const deferredQuery = useDeferredValue(query)

  return useMemo(
    () => (entries ? searchOpenTabs({ ...entries, query: deferredQuery }) : EMPTY_RESULTS),
    [deferredQuery, entries]
  )
}
