// Reobserve the prefetch sentinel after each page/reset to keep loading until prepends move it out; the virtualizer preserves position.

import { useEffect, useEffectEvent, useState } from 'react'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

export const NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX = 600

export type NativeChatOlderHistoryAutoload = {
  sentinelRef: (node: HTMLElement | null) => void
  /** Offer manual loading after failure/no progress or without IntersectionObserver. */
  isAutoLoadEnabled: boolean
  /** Manual load: clears a failure so auto-load resumes if it succeeds. */
  loadEarlierManually: () => void
}

export function useNativeChatOlderHistoryAutoload({
  scrollRef,
  historyKey,
  isVisible,
  hasMore,
  loadingEarlier,
  loadEarlier
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  /** Include the paging generation so reconnects/resets clear old failures. */
  historyKey: string
  isVisible: boolean
  hasMore: boolean
  loadingEarlier: boolean
  /** Joins the page already in flight, if any. */
  loadEarlier: () => Promise<NativeChatOlderPageResult>
}): NativeChatOlderHistoryAutoload {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  // A swapped transcript must not inherit another history’s failure.
  const [failedHistoryKey, setFailedHistoryKey] = useState<string | null>(null)

  const canObserve = typeof IntersectionObserver !== 'undefined'
  const isAutoLoadEnabled = canObserve && failedHistoryKey !== historyKey
  const shouldObserve = isAutoLoadEnabled && isVisible && hasMore && !loadingEarlier

  // Let the lane own in-flight state so abandoned reads cannot strand a latch; stop on no progress to prevent endless observer reloads.
  const loadPage = (): void => {
    void loadEarlier().then((result) => {
      if (result === 'failed' || result === 'unchanged') {
        setFailedHistoryKey(historyKey)
      }
    })
  }
  // Lane callbacks change identity with their state; the observer must not.
  const loadPageFromObserver = useEffectEvent(loadPage)

  const loadEarlierManually = (): void => {
    setFailedHistoryKey(null)
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

  return { sentinelRef: setSentinel, isAutoLoadEnabled, loadEarlierManually }
}
