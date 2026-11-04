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
  // Preserve empty-result identity so memoized consumers do not churn on a replacement empty array.
  if (resultsQuery.trim() === query.trim() || results.length === 0) {
    return results
  }
  if (!query.trim() || !entries) {
    return NO_RESULTS
  }
  // Recheck with search engines because row text omits matchable fields; Enter must match the query currently shown.
  const liveResultIds = new Set(
    searchOpenTabs({ ...entriesBehindResults(entries, results), query }).map((result) => result.id)
  )
  const retained = results.filter((result) => liveResultIds.has(result.id))
  // Why the same array: an unchanged list must not invalidate the row memos.
  return retained.length === results.length ? results : retained
}

// Limit rechecks to displayed entries so the engine’s result cap cannot truncate their matches.
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
