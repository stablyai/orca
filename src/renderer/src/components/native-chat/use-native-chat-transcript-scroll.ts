// The transcript's scroll behaviour: staying pinned to the bottom while a turn
// streams, offering the way back when the reader has left, aligning a row or a
// card to the top, and paging in older history.
//
// Split from the list because windowing changed what these have to be careful
// about, not what they decide: rows resolving their measured height move the
// content constantly, so "the content changed" and "the reader scrolled" stopped
// being the same event and only the latter may ask for another page.
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
  nextFollowingEnd,
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
  hasMore,
  loadingEarlier,
  loadEarlier,
  alignToViewportTop,
  scrollToEnd,
  consumeProgrammaticScroll,
  reconcileReaderScroll
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
  scrollToEnd: () => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
}): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const followingRef = useRef(true)
  const previousScrollTopRef = useRef(0)
  const loadEarlierRequestedAtRef = useRef<number | null>(null)

  const syncScrollState = useCallback(
    (event?: Event): ScrollGeometry | null => {
      const element = scrollRef.current

      if (!element) {
        return null
      }

      const geometry = geometryOf(element)

      if (event) {
        const wasFollowing = followingRef.current
        const programmatic = consumeProgrammaticScroll(event)

        const following = nextFollowingEnd({
          following: followingRef.current,
          programmatic,
          geometry
        })

        followingRef.current = following

        if (!programmatic) {
          reconcileReaderScroll(wasFollowing && !following)
        }
      }

      setShowJump(shouldShowJumpToLatest(followingRef.current, geometry))

      return geometry
    },
    [consumeProgrammaticScroll, reconcileReaderScroll, scrollRef]
  )

  // Only a real scroll event pages in older history. Every row that resolves its
  // true height moves the content and re-fires the size observers; routing those
  // through here too would ask for the next page once per measurement.
  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const geometry = syncScrollState(event.nativeEvent)

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
    },
    [hasMore, itemCount, loadEarlier, loadingEarlier, syncScrollState]
  )

  const scrollToBottom = useCallback(() => {
    followingRef.current = true
    scrollToEnd()
    setShowJump(false)
  }, [scrollToEnd])

  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      followingRef.current = false
      alignToViewportTop(element)
    },
    [alignToViewportTop]
  )

  useLayoutEffect(() => {
    if (followingRef.current) {
      scrollToEnd()
    }
  }, [itemCount, isWorking, showTypingIndicator, scrollToEnd])

  useEffect(() => {
    const element = scrollRef.current

    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      if (followingRef.current) {
        scrollToEnd()
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
  }, [contentRef, scrollRef, scrollToEnd, syncScrollState])

  return { showJump, onScroll, scrollToBottom, scrollMessageToTop }
}
