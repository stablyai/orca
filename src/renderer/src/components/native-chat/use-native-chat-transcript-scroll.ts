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
// it is still reconciling is replaced rather than raced. Its public write adapter
// marks every application offset; follow intent changes only on an unmarked
// reader event, never from delayed geometry alone.

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
}

export function useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount,
  isWorking,
  showTypingIndicator,
  isVisible,
  alignToViewportTop,
  scrollToEnd,
  restoreScrollOffset,
  consumeProgrammaticScroll,
  reconcileReaderScroll
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  showTypingIndicator: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement) => void
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

  const syncScrollState = useCallback(
    (event?: Event): ScrollGeometry | null => {
      const element = scrollRef.current
      if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
        return null
      }
      const geometry = geometryOf(element)
      if (event) {
        const wasFollowing = followingRef.current
        const programmatic = consumeProgrammaticScroll(event)
        const following = nextFollowingEnd({
          following: followingRef.current,
          programmatic,
          geometry,
          previousDistanceFromEnd: previousDistanceFromEndRef.current
        })
        followingRef.current = following
        if (!programmatic) {
          reconcileReaderScroll(wasFollowing && !following)
        }
      }
      detachedScrollTopRef.current = followingRef.current ? null : geometry.scrollTop
      setShowJump(shouldShowJumpToLatest(followingRef.current, geometry))
      return geometry
    },
    [consumeProgrammaticScroll, reconcileReaderScroll, scrollRef]
  )

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const geometry = syncScrollState(event.nativeEvent)
      if (geometry) {
        previousDistanceFromEndRef.current = distanceFromBottom(geometry)
      }
    },
    [syncScrollState]
  )

  const scrollToEndWhenMeasurable = useCallback(() => {
    if (hasMeasurableViewport(scrollRef.current)) {
      scrollToEnd()
    }
  }, [scrollRef, scrollToEnd])

  const scrollToBottom = useCallback(() => {
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
      if (revealed && detachedScrollTopRef.current !== null) {
        restoreScrollOffset(detachedScrollTopRef.current)
      }
      return
    }
    scrollToEndWhenMeasurable()
  }, [
    isVisible,
    itemCount,
    isWorking,
    restoreScrollOffset,
    showTypingIndicator,
    scrollToEndWhenMeasurable
  ])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (followingRef.current) {
        scrollToEndWhenMeasurable()
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
  }, [contentRef, scrollRef, scrollToEndWhenMeasurable, syncScrollState])

  return { showJump, onScroll, scrollToBottom, scrollMessageToTop }
}
