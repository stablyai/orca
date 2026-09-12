// Keeps deferred tab rows on screen while typing races ahead of search.

import { searchOpenTabs, type OpenTabSearchResult } from './open-tab-search'
import type { OpenTabSearchEntries } from './open-tab-search-entries'

const NO_RESULTS: readonly OpenTabSearchResult[] = []

export function retainOpenTabResultsForQuery({
  entries,
  query,
  results,
  resultsQuery
}: {
  entries: OpenTabSearchEntries | null
  query: string
  results: readonly OpenTabSearchResult[]
  resultsQuery: string
}): readonly OpenTabSearchResult[] {
  // Why return `results` when empty: an already-empty list must keep its identity
  // rather than flip to another empty array and churn the caller's memos.
  if (resultsQuery.trim() === query.trim() || results.length === 0) {
    return results
  }
  if (!query.trim() || !entries) {
    return NO_RESULTS
  }
  // Why re-run the engines instead of re-reading the row text: only they know
  // every matchable field — type aliases, absolute paths, agent snippets,
  // browser workspace labels — and Enter must never submit a row the query on
  // screen does not match.
  const liveResultIds = new Set(
    searchOpenTabs({ ...entriesBehindResults(entries, results), query }).map((result) => result.id)
  )
  const retained = results.filter((result) => liveResultIds.has(result.id))
  // Why the same array: an unchanged list must not invalidate the row memos.
  return retained.length === results.length ? results : retained
}

// Narrowing to the rows on screen keeps the re-check to string work on at most
// OPEN_TAB_SEARCH_RESULT_LIMIT entries, so its own limit can never truncate.
function entriesBehindResults(
  entries: OpenTabSearchEntries,
  results: readonly OpenTabSearchResult[]
): OpenTabSearchEntries {
  const workspaceTabIds = new Set<string>()
  const browserPageIds = new Set<string>()
  const simulatorTabIds = new Set<string>()
  for (const result of results) {
    if (result.source === 'workspace') {
      workspaceTabIds.add(result.tabId)
    } else if (result.source === 'browser') {
      browserPageIds.add(result.pageId)
    } else {
      simulatorTabIds.add(result.tabId)
    }
  }
  return {
    workspaceTabs: entries.workspaceTabs.filter((entry) => workspaceTabIds.has(entry.tab.id)),
    browserPages: entries.browserPages.filter((entry) => browserPageIds.has(entry.page.id)),
    simulatorTabs: entries.simulatorTabs.filter((entry) => simulatorTabIds.has(entry.tab.id))
  }
}
