// The transcript's scroll behaviour: staying pinned to the bottom while a turn
// streams, offering the way back when the reader has left, and aligning a row or
// a card to the top.
//
// Split from the list because windowing changed what these have to be careful
// about, not what they decide: rows resolving their measured height move the
// content constantly, so "the content changed" and "the reader scrolled" stopped
// being the same event.
//
// The offset belongs to the virtualizer — every pin goes through it, so a scroll
// it is still reconciling is replaced rather than raced. Following stops only on a
// reader gesture or a row jump, never on layout or an application write, and
// resumes when the reader returns to the end.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEventHandler
} from 'react'
import {
  distanceFromBottom,
  isNearBottom,
  NATIVE_CHAT_FOLLOW_REARM_PX,
  nextFollowingEnd,
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

function hasMeasurableViewport(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.clientHeight > 0
}

export type NativeChatTranscriptScroll = {
  showJump: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  scrollToBottom: () => void
  /** Align an element inside the transcript with the top of the viewport. */
  scrollMessageToTop: (element: HTMLElement) => void
  /** A reader gesture left the end: the only thing besides a row jump that stops following. */
  readerLeavesEnd: () => void
}

export function useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount,
  isWorking,
  showsTailRow,
  isVisible,
  alignToViewportTop,
  isAlignPending,
  scrollToEnd,
  restoreScrollOffset,
  consumeProgrammaticScroll,
  reconcileReaderScroll
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  /** Whether the list draws a row after the transcript (live activity or a wait). */
  showsTailRow: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement) => void
  /** Whether a jump to a row is still travelling there. */
  isAlignPending: () => boolean
  scrollToEnd: () => void
  restoreScrollOffset: (offset: number) => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
}): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const followingRef = useRef(true)
  const detachedScrollTopRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  const previousIsVisibleRef = useRef(isVisible)
  const previousDistanceFromEndRef = useRef(Number.POSITIVE_INFINITY)

  const syncScrollState = useCallback((): ScrollGeometry | null => {
    const element = scrollRef.current
    if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
      return null
    }
    const geometry = geometryOf(element)
    detachedScrollTopRef.current = followingRef.current ? null : geometry.scrollTop
    setShowJump(shouldShowJumpToLatest(followingRef.current, geometry))
    return geometry
  }, [scrollRef])

  const readerLeavesEnd = useCallback(() => {
    followingRef.current = false
    const element = scrollRef.current
    if (element) {
      previousDistanceFromEndRef.current = distanceFromBottom(geometryOf(element))
    }
    // Replace a pending virtualizer target before the browser applies the gesture.
    reconcileReaderScroll(true)
    syncScrollState()
  }, [reconcileReaderScroll, scrollRef, syncScrollState])

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const element = scrollRef.current
      if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
        return
      }
      const geometry = geometryOf(element)
      followingRef.current = nextFollowingEnd({
        following: followingRef.current,
        programmatic: consumeProgrammaticScroll(event.nativeEvent),
        geometry,
        previousDistanceFromEnd: previousDistanceFromEndRef.current,
        settling: isAlignPending()
      })
      reconcileReaderScroll(false)
      previousDistanceFromEndRef.current = distanceFromBottom(geometry)
      syncScrollState()
    },
    [consumeProgrammaticScroll, isAlignPending, reconcileReaderScroll, scrollRef, syncScrollState]
  )

  const scrollToEndWhenMeasurable = useCallback(() => {
    if (isVisibleRef.current && hasMeasurableViewport(scrollRef.current)) {
      scrollToEnd()
    }
  }, [scrollRef, scrollToEnd])

  const scrollToBottom = useCallback(() => {
    // A hidden pane is not where the reader is; it keeps its position for their return.
    if (!isVisibleRef.current) {
      return
    }
    followingRef.current = true
    scrollToEndWhenMeasurable()
    setShowJump(false)
  }, [scrollToEndWhenMeasurable])

  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      followingRef.current = false
      alignToViewportTop(element)
    },
    [alignToViewportTop]
  )

  useLayoutEffect(() => {
    const revealed = isVisible && !previousIsVisibleRef.current
    isVisibleRef.current = isVisible
    previousIsVisibleRef.current = isVisible
    if (!isVisible) {
      return
    }
    if (!followingRef.current) {
      if (revealed) {
        if (detachedScrollTopRef.current !== null) {
          restoreScrollOffset(detachedScrollTopRef.current)
        }
        // What changed while hidden may have brought the end to the restored offset.
        const element = scrollRef.current
        if (hasMeasurableViewport(element)) {
          followingRef.current = isNearBottom(geometryOf(element), NATIVE_CHAT_FOLLOW_REARM_PX)
        }
      }
      syncScrollState()
      return
    }
    scrollToEndWhenMeasurable()
  }, [
    isVisible,
    itemCount,
    isWorking,
    restoreScrollOffset,
    scrollRef,
    showsTailRow,
    scrollToEndWhenMeasurable,
    syncScrollState
  ])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!isVisibleRef.current) {
        return
      }
      // Growth, an opened row included, keeps a following reader at the end.
      if (followingRef.current) {
        scrollToEndWhenMeasurable()
      }
      syncScrollState()
    })
    // Observe the growing content, not just the fixed-height viewport, so an
    // in-place streaming growth is seen; also watch the viewport for reflows.
    observer.observe(element)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }
    return () => observer.disconnect()
  }, [contentRef, scrollRef, scrollToEndWhenMeasurable, syncScrollState])

  return { showJump, onScroll, scrollToBottom, scrollMessageToTop, readerLeavesEnd }
}
