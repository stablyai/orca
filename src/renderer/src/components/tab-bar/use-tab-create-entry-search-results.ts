import { retainOpenTabResultsForQuery } from './open-tab-search-retention'
import { EMPTY_TAB_RESULTS } from './tab-create-entry-empty-options'
import { useOpenTabSearch } from './use-open-tab-search'
import type { OpenTabSearchResult } from './open-tab-search'
import { useTranslate } from '../../i18n/use-translate'

export function useTabCreateEntrySearchResults({
  enabled,
  query,
  worktreeId,
  retainedResultId
}: {
  enabled: boolean
  query: string
  worktreeId: string
  retainedResultId?: string | null
}): readonly OpenTabSearchResult[] {
  const t = useTranslate()
  const tabSearch = useOpenTabSearch({
    enabled,
    query: enabled ? query : '',
    worktreeId,
    retainedResultId
  })
  // Retain only deferred rows matching the live query so typing cannot flash empty results or submit stale targets.
  return enabled
    ? retainOpenTabResultsForQuery(
        {
          entries: tabSearch.entries,
          query,
          results: tabSearch.results,
          resultsQuery: tabSearch.query
        },
        t
      )
    : EMPTY_TAB_RESULTS
}
