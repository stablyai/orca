// The transcript's scroll behaviour: staying pinned to the bottom while a turn
// streams, offering the way back when the reader has left, aligning a row or a
// card to the top, and paging in older history.
//
// Split from the list because windowing changed what these have to be careful
// about, not what they decide: rows resolving their measured height move the
// content constantly, so "the content changed" and "the reader scrolled" stopped
// being the same event and only the latter may ask for another page.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isNearBottom,
  shouldLoadEarlier,
  shouldShowJumpToLatest,
  type ScrollGeometry
} from './native-chat-autoscroll'

function geometryOf(element: HTMLElement): ScrollGeometry {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  }
}

export type NativeChatTranscriptScroll = {
  showJump: boolean
  onScroll: () => void
  scrollToBottom: () => void
  /** Align an element inside the transcript with the top of the viewport. */
  scrollMessageToTop: (element: HTMLElement) => void
}

export function useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount,
  isWorking,
  showTypingIndicator,
  hasMore,
  loadingEarlier,
  loadEarlier,
  alignToViewportTop
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  showTypingIndicator: boolean
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
  alignToViewportTop: (element: HTMLElement) => void
}): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const stuckToBottomRef = useRef(true)
  const previousScrollTopRef = useRef(0)
  const loadEarlierRequestedAtRef = useRef<number | null>(null)

  const syncScrollState = useCallback((): ScrollGeometry | null => {
    const element = scrollRef.current
    if (!element) {
      return null
    }
    const geometry = geometryOf(element)
    const stick = isNearBottom(geometry)
    stuckToBottomRef.current = stick
    setShowJump(shouldShowJumpToLatest(stick, geometry))
    return geometry
  }, [scrollRef])

  // Only a real scroll event pages in older history. Every row that resolves its
  // true height moves the content and re-fires the size observers; routing those
  // through here too would ask for the next page once per measurement.
  const onScroll = useCallback(() => {
    const geometry = syncScrollState()
    if (!geometry) {
      return
    }
    const previousScrollTop = previousScrollTopRef.current
    previousScrollTopRef.current = geometry.scrollTop
    if (
      shouldLoadEarlier({
        geometry,
        previousScrollTop,
        hasMore,
        loadingEarlier,
        itemCount,
        requestedAtItemCount: loadEarlierRequestedAtRef.current
      })
    ) {
      loadEarlierRequestedAtRef.current = itemCount
      loadEarlier()
    }
  }, [hasMore, itemCount, loadEarlier, loadingEarlier, syncScrollState])

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    // The document's own bottom, not the window's last row: the typing indicator,
    // the activity line and the column's end padding all live past it.
    element.scrollTop = element.scrollHeight
    stuckToBottomRef.current = true
    setShowJump(false)
  }, [scrollRef])

  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      stuckToBottomRef.current = false
      alignToViewportTop(element)
    },
    [alignToViewportTop]
  )

  useLayoutEffect(() => {
    if (stuckToBottomRef.current) {
      scrollToBottom()
    }
  }, [itemCount, isWorking, showTypingIndicator, scrollToBottom])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (stuckToBottomRef.current) {
        scrollToBottom()
      } else {
        syncScrollState()
      }
    })
    // Observe the growing content, not just the fixed-height viewport, so an
    // in-place streaming growth is seen; also watch the viewport for reflows.
    observer.observe(element)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }
    return () => observer.disconnect()
  }, [contentRef, scrollRef, scrollToBottom, syncScrollState])

  return { showJump, onScroll, scrollToBottom, scrollMessageToTop }
}
