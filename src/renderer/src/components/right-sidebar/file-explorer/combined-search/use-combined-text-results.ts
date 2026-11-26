import { useDeferredValue, useMemo } from 'react'
import type { FileSearchResultOwner } from '@/lib/files/search/file-search-result-owner'
import type { FileSearchWorktreeState } from '@/store/slices/editor/types/file-search-worktree-state'
import { buildSearchRows } from '../content-search/search-rows'
import { isTextSearchQuery } from '../content-search/useFileSearchRunner'

/** The text half of the combined search: which stored generation belongs to the live draft, and whether it is pending. */
export function useCombinedTextResults({
  query,
  forcedShortQuery,
  searchState,
  collapsedFiles,
  isCurrentOwner
}: {
  query: string
  forcedShortQuery: string | null
  searchState: FileSearchWorktreeState | null | undefined
  collapsedFiles: ReadonlySet<string>
  isCurrentOwner: (owner: FileSearchResultOwner | null | undefined) => boolean
}) {
  const committedQuery = searchState?.query ?? ''
  const storedResults = searchState?.results ?? null
  const storedResultOwner = searchState?.resultOwner ?? null
  const textLoading = searchState?.loading ?? false
  const textQueryActive =
    isTextSearchQuery(query) || (forcedShortQuery === query && query.trim().length > 0)
  // Only results committed for the live draft are shown or activated, never a previous query's.
  const resultsAreCurrent =
    textQueryActive && committedQuery === query && isCurrentOwner(storedResultOwner)
  const committedResults = useMemo(
    () => ({
      results: resultsAreCurrent ? storedResults : null,
      owner: resultsAreCurrent ? storedResultOwner : null,
      query: committedQuery
    }),
    [committedQuery, resultsAreCurrent, storedResultOwner, storedResults]
  )
  // Large result sets render at lower priority so the field and name rows stay responsive.
  const deferredResults = useDeferredValue(committedResults)
  // The deferred payload is shown and activated only when it is the live query's own generation.
  const deferredIsLive =
    resultsAreCurrent &&
    deferredResults.query === query &&
    deferredResults.owner === storedResultOwner
  // While the deferred render still holds an older payload, the text half is pending, not a miss.
  const deferredLagging = resultsAreCurrent && deferredResults.results !== storedResults
  const textRows = useMemo(
    () => buildSearchRows(deferredResults.results, collapsedFiles),
    [collapsedFiles, deferredResults.results]
  )
  // A skipped scan settles its reason without an owner (a known limit, shown muted); any other error
  // must come from the current owner.
  const settledError =
    textQueryActive && committedQuery === query ? (searchState?.error ?? null) : null
  const textNotice = settledError && storedResultOwner === null ? settledError : null
  const textError = settledError && isCurrentOwner(storedResultOwner) ? settledError : null
  // Results are null only before a scan settles (a settled miss is an empty result), so that is pending too.
  const textPending =
    textQueryActive &&
    (committedQuery !== query ||
      textLoading ||
      (storedResults === null && !searchState?.error) ||
      deferredLagging)

  return { deferredResults, deferredIsLive, textRows, textError, textNotice, textPending }
}
