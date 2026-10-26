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
// One-character matches swamp a 200-entry history corpus and displace useful omnibox results.
export const OMNIBOX_BROWSER_HISTORY_MIN_QUERY_LENGTH = 2

const NO_ROWS: readonly BrowserHistoryOmniboxRow[] = []

// Do not reveal history on an empty omnibox: users may open it in front of other people.
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
  // Preserve empty-result identity instead of invalidating consumers with another empty array.
  if (rowsQuery.trim() === query.trim() || rows.length === 0) {
    return rows
  }
  // Recheck displayed rows against the live query so Enter cannot navigate a stale match.
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
  // Snapshot history per open so background navigations cannot reshuffle results or selection while typing.
  const history = useMemo(
    () => (enabled ? useAppStore.getState().browserUrlHistory : null),
    [enabled]
  )
  const prepared = useMemo(
    () => (history ? prepareBrowserHistoryEntries(history) : null),
    [history]
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
