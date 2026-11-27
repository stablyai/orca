import { useCallback, useEffect, useRef, useState } from 'react'

type TextSearchOptions = { allowShortQuery?: boolean }
type TextSearchRequest = { query: string; allowShortQuery: boolean; requestedAt: number }

/**
 * Holds each text scan until the same query's file-name listing settles. On a large repo both are
 * disk walks, so a scan started alongside the listing would make file names wait behind text.
 */
export function useNamesFirstTextSearch({
  namesSettled,
  executeSearch,
  stopSearch,
  cancelPendingSearch
}: {
  /** False while the name listing for the live query is still loading. */
  namesSettled: boolean
  executeSearch: (query: string, options?: TextSearchOptions & { waitedMs?: number }) => void
  /** Stops a debouncing or running scan; true when one was stopped. */
  stopSearch: () => boolean
  cancelPendingSearch: (options?: { interrupted?: boolean }) => void
}): {
  requestTextSearch: (query: string, options?: TextSearchOptions) => void
  cancelTextSearch: () => void
} {
  const queuedRef = useRef<TextSearchRequest | null>(null)
  // The launched request, kept until its listing is known to have stayed settled.
  const launchedRef = useRef<TextSearchRequest | null>(null)
  const [queueVersion, setQueueVersion] = useState(0)

  const requestTextSearch = useCallback(
    (query: string, options?: TextSearchOptions) => {
      // Why: stop the previous scan at once, so it never competes with this query's name listing.
      stopSearch()
      launchedRef.current = null
      queuedRef.current = {
        query,
        allowShortQuery: options?.allowShortQuery ?? false,
        requestedAt: Date.now()
      }
      setQueueVersion((version) => version + 1)
    },
    [stopSearch]
  )
  const cancelTextSearch = useCallback(() => {
    const owed = queuedRef.current !== null
    queuedRef.current = null
    launchedRef.current = null
    cancelPendingSearch({ interrupted: owed })
  }, [cancelPendingSearch])

  useEffect(() => {
    if (!namesSettled) {
      // Why: a listing can report settled for one render before its request starts (the first
      // query of a session); when it then loads, hold the scan it let through until it settles.
      const launched = launchedRef.current
      launchedRef.current = null
      if (launched && stopSearch()) {
        queuedRef.current = launched
      }
      return
    }
    const queued = queuedRef.current
    if (!queued) {
      return
    }
    queuedRef.current = null
    launchedRef.current = queued
    executeSearch(queued.query, {
      allowShortQuery: queued.allowShortQuery,
      // The wait for names already covered the pause, so typing still sends one scan per pause.
      waitedMs: Date.now() - queued.requestedAt
    })
  }, [executeSearch, namesSettled, queueVersion, stopSearch])

  return { requestTextSearch, cancelTextSearch }
}
