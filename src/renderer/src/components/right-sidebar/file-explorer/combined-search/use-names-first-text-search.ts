import { useCallback, useEffect, useRef, useState } from 'react'

type TextSearchOptions = { allowShortQuery?: boolean }
type QueuedTextSearch = { query: string; allowShortQuery: boolean }

/**
 * Holds each text scan until the same query's file-name listing settles. On a large repo both are
 * disk walks, so a scan started alongside the listing would make file names wait behind text.
 */
export function useNamesFirstTextSearch({
  namesSettled,
  executeSearch,
  stopSearch
}: {
  /** False while the name listing for the live query is still loading. */
  namesSettled: boolean
  executeSearch: (query: string, options?: TextSearchOptions) => void
  stopSearch: () => void
}): {
  requestTextSearch: (query: string, options?: TextSearchOptions) => void
  dropQueuedTextSearch: () => void
} {
  const queuedRef = useRef<QueuedTextSearch | null>(null)
  const [queueVersion, setQueueVersion] = useState(0)

  const requestTextSearch = useCallback(
    (query: string, options?: TextSearchOptions) => {
      // Why: stop the previous scan at once, so it never competes with this query's name listing.
      stopSearch()
      queuedRef.current = { query, allowShortQuery: options?.allowShortQuery ?? false }
      setQueueVersion((version) => version + 1)
    },
    [stopSearch]
  )
  const dropQueuedTextSearch = useCallback(() => {
    queuedRef.current = null
  }, [])

  useEffect(() => {
    const queued = queuedRef.current
    if (!queued || !namesSettled) {
      return
    }
    queuedRef.current = null
    executeSearch(queued.query, { allowShortQuery: queued.allowShortQuery })
  }, [executeSearch, namesSettled, queueVersion])

  return { requestTextSearch, dropQueuedTextSearch }
}
