// Feeds the omnibox history block from the store: gated read, per-open prepare,
// deferred match, retention across a stale query.

import { useDeferredValue, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  matchBrowserHistory,
  prepareBrowserHistoryEntries,
  type PreparedBrowserHistoryEntry
} from '@/lib/browser-history-match'
import { isBrowserAddressBarQueryTooLarge } from '../browser-pane/assemble-chrome/browser-address-bar-suggestions'
import { dropHistoryRowsCoveredByBrowserPages } from './open-tab-entry-dedupe'
import { isTabEntryAbsolutePathLike } from './tab-create-entry-action'
import { parseForcedSearchQuery } from './tab-create-entry-forced-search'
import type { OpenTabSearchResult } from './open-tab-search'
import type { BrowserHistoryOmniboxRow } from './tab-create-entry-active-option'

export const OMNIBOX_BROWSER_HISTORY_LIMIT = 3
// One character substring-matches most of a 200-entry corpus and would push the
// rows the omnibox exists for off the list.
export const OMNIBOX_BROWSER_HISTORY_MIN_QUERY_LENGTH = 2

const NO_ROWS: readonly BrowserHistoryOmniboxRow[] = []

// Unlike the address bar, an empty omnibox shows no history at all: ⌘T is
// pressed in front of other people and must not become a browsing-history display.
export function isOmniboxBrowserHistoryQueryEligible(query: string): boolean {
  const trimmed = query.trim()
  return (
    trimmed.length >= OMNIBOX_BROWSER_HISTORY_MIN_QUERY_LENGTH &&
    !isBrowserAddressBarQueryTooLarge(query) &&
    // `/Users/...` is a file intent and `?foo` an explicit web-search intent.
    !isTabEntryAbsolutePathLike(trimmed) &&
    !parseForcedSearchQuery(query).forced
  )
}

function matchRows(
  prepared: readonly PreparedBrowserHistoryEntry[] | null,
  query: string
): readonly BrowserHistoryOmniboxRow[] {
  if (!prepared || !isOmniboxBrowserHistoryQueryEligible(query)) {
    return NO_ROWS
  }
  // url-tail is dropped here: a query-string coincidence is not a destination.
  const matches = matchBrowserHistory({
    includeUrlTail: false,
    limit: OMNIBOX_BROWSER_HISTORY_LIMIT,
    prepared,
    query
  })
  return matches.length === 0
    ? NO_ROWS
    : matches.map((match) => ({ entry: match.entry, id: `history:${match.entry.normalizedUrl}` }))
}

export function retainBrowserHistoryRowsForQuery({
  query,
  rows,
  rowsQuery
}: {
  query: string
  rows: readonly BrowserHistoryOmniboxRow[]
  rowsQuery: string
}): readonly BrowserHistoryOmniboxRow[] {
  // Why return `rows` when empty: an already-empty list must keep its identity
  // rather than flip to another empty array and churn the caller's memos.
  if (rowsQuery.trim() === query.trim() || rows.length === 0) {
    return rows
  }
  // Re-checking only the rows on screen keeps retention free and stops Enter
  // from ever opening a page the visible text no longer matches.
  const onScreen = prepareBrowserHistoryEntries(rows.map((row) => row.entry))
  const liveIds = new Set(matchRows(onScreen, query).map((row) => row.id))
  const retained = rows.filter((row) => liveIds.has(row.id))
  return retained.length === rows.length ? rows : retained
}

export function useOmniboxBrowserHistory({
  enabled,
  query,
  tabResults
}: {
  enabled: boolean
  query: string
  tabResults: readonly OpenTabSearchResult[]
}): readonly BrowserHistoryOmniboxRow[] {
  // Why read once: the tab bar is mounted for every workspace, and this array
  // is replaced on every committed navigation in any browser tab. History is
  // intentionally a per-open snapshot so background navigations cannot churn
  // the omnibox or reshuffle a selection under the user's fingers.
  const history = useMemo(
    () => (enabled ? useAppStore.getState().browserUrlHistory : null),
    [enabled]
  )
  const prepared = useMemo(
    () => (history ? prepareBrowserHistoryEntries(history) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Snapshot per menu open; a background navigation must not reshuffle rows mid-keystroke.
    [enabled]
  )
  const deferredQuery = useDeferredValue(query)
  const deferredRows = useMemo(() => matchRows(prepared, deferredQuery), [deferredQuery, prepared])
  return useMemo(() => {
    if (!enabled) {
      return NO_ROWS
    }
    const retained = retainBrowserHistoryRowsForQuery({
      query,
      rows: deferredRows,
      rowsQuery: deferredQuery
    })
    return dropHistoryRowsCoveredByBrowserPages(retained, tabResults)
  }, [deferredQuery, deferredRows, enabled, query, tabResults])
}
