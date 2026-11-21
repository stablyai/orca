// Reobserve the prefetch sentinel after each page/reset to keep loading until prepends move it out; the virtualizer preserves position.

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export const NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX = 600

export type NativeChatOlderHistoryAutoload = {
  sentinelRef: (node: HTMLElement | null) => void
  /** Offer manual loading after failure/no progress or without IntersectionObserver. */
  isAutoLoadEnabled: boolean
  /** The last read of this history failed (not merely empty), so the row offers a retry. */
  loadFailed: boolean
  /** Manual load: clears a failure so auto-load resumes if it succeeds. */
  loadEarlierManually: () => void
  /** The lane's load, recording a failure so any caller's (a history jump's) shows the error. */
  loadEarlier: (pageSize?: number) => Promise<NativeChatOlderPageResult>
}

export function useNativeChatOlderHistoryAutoload({
  scrollRef,
  historyKey,
  isVisible,
  hasMore,
  autoLoad = true,
  onManualLoad,
  loadingEarlier,
  loadEarlier
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  /** Include the paging generation so reconnects/resets clear old failures. */
  historyKey: string
  isVisible: boolean
  hasMore: boolean
  autoLoad?: boolean
  onManualLoad?: () => void
  loadingEarlier: boolean
  /** Joins the page already in flight, if any. */
  loadEarlier: (pageSize?: number) => Promise<NativeChatOlderPageResult>
}): NativeChatOlderHistoryAutoload {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  // A swapped transcript must not inherit another history’s failure.
  const [failedHistoryKey, setFailedHistoryKey] = useState<string | null>(null)
  const [readFailedHistoryKey, setReadFailedHistoryKey] = useState<string | null>(null)
  // A result for a history that's no longer shown must not touch the current one's state.
  const currentKey = useRef(historyKey)
  useEffect(() => {
    currentKey.current = historyKey
  })
  // Any page load (a retry, a history jump) starts fresh; only a failure brings the error back.
  const [wasLoading, setWasLoading] = useState(loadingEarlier)
  if (loadingEarlier !== wasLoading) {
    setWasLoading(loadingEarlier)
    if (loadingEarlier) {
      setReadFailedHistoryKey(null)
    }
  }

  const canObserve = typeof IntersectionObserver !== 'undefined'
  const isAutoLoadEnabled = autoLoad && canObserve && failedHistoryKey !== historyKey
  const shouldObserve = isAutoLoadEnabled && isVisible && hasMore && !loadingEarlier

  // Let the lane own in-flight state so abandoned reads cannot strand a latch; stop on no progress to prevent endless observer reloads.
  const loadRecorded = (pageSize?: number): Promise<NativeChatOlderPageResult> => {
    const key = historyKey
    // Cleared now too: a read can settle before the render that commits its loading state.
    setReadFailedHistoryKey(null)
    return loadEarlier(pageSize).then((result) => {
      // Any caller's failure stops auto-load too, so the row shows the error instead of retrying.
      if (key === currentKey.current && (result === 'failed' || result === 'unchanged')) {
        setFailedHistoryKey(key)
        if (result === 'failed') {
          setReadFailedHistoryKey(key)
        }
      }
      return result
    })
  }
  const loadPage = (): void => {
    void loadRecorded()
  }
  // Lane callbacks change identity with their state; the observer must not.
  const loadPageFromObserver = useEffectEvent(loadPage)

  const loadEarlierManually = (): void => {
    onManualLoad?.()
    setFailedHistoryKey(null)
    setReadFailedHistoryKey(null)
    loadPage()
  }

  // Paging resets must recheck range even if loading never toggled.
  useEffect(() => {
    const root = scrollRef.current
    if (!shouldObserve || !sentinel || !root) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.at(-1)?.isIntersecting) {
          loadPageFromObserver()
        }
      },
      { root, rootMargin: `${NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX}px 0px 0px 0px` }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scrollRef, sentinel, shouldObserve, historyKey])

  return {
    sentinelRef: setSentinel,
    isAutoLoadEnabled,
    loadFailed: readFailedHistoryKey === historyKey,
    loadEarlierManually,
    loadEarlier: loadRecorded
  }
}
