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
// marks every application offset; follow intent changes only on a reader's own
// act — an unmarked scroll, a navigation, or opening or closing a row — never from
// delayed geometry alone. A detach remembers which act caused it: one caused only
// by opening rows ends when the last of those rows closes, wherever the end is by then.

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
  FOLLOWING,
  nextFollowState,
  shouldShowJumpToLatest,
  type FollowEvent,
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
  /** More than a viewport below the top of what is loaded. */
  awayFromTop: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  scrollToBottom: () => void
  scrollToTop: () => void
  /** Align an element inside the transcript with the top of the viewport. */
  scrollMessageToTop: (element: HTMLElement) => void
  /** The reader opened a row to read it: leave it where it is. */
  readerOpened: (row: string) => void
  /** The reader closed a row: follow again if only their opens had stopped it. */
  readerClosed: (row: string) => void
  /** Wraps an act so it lapses if the reader acts first. */
  untilReaderActs: (act: () => void) => () => void
}

export function useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount,
  isWorking,
  showsTailRow,
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
  /** Whether the list draws a row after the transcript (live activity or a wait). */
  showsTailRow: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement) => void
  scrollToEnd: () => void
  restoreScrollOffset: (offset: number) => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
}): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const [awayFromTop, setAwayFromTop] = useState(false)
  const followRef = useRef(FOLLOWING)
  const detachedScrollTopRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  const previousIsVisibleRef = useRef(isVisible)
  const previousDistanceFromEndRef = useRef(Number.POSITIVE_INFINITY)

  /** Applies a reader's act; true when the transcript follows its end afterwards. */
  const readerActsRef = useRef(0)
  const follow = useCallback((event: FollowEvent): boolean => {
    if (event.kind !== 'scroll' || !event.programmatic) {
      readerActsRef.current += 1
    }
    followRef.current = nextFollowState(followRef.current, event)
    return followRef.current.kind === 'following'
  }, [])

  const syncScrollState = useCallback(
    (event?: Event): ScrollGeometry | null => {
      const element = scrollRef.current
      if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
        return null
      }
      const geometry = geometryOf(element)
      if (event) {
        const wasFollowing = followRef.current.kind === 'following'
        const programmatic = consumeProgrammaticScroll(event)
        const following = follow({
          kind: 'scroll',
          programmatic,
          geometry,
          previousDistanceFromEnd: previousDistanceFromEndRef.current
        })
        if (!programmatic) {
          reconcileReaderScroll(wasFollowing && !following)
        }
      }
      const following = followRef.current.kind === 'following'
      detachedScrollTopRef.current = following ? null : geometry.scrollTop
      setShowJump(shouldShowJumpToLatest(following, geometry))
      setAwayFromTop(geometry.scrollTop > geometry.clientHeight)
      return geometry
    },
    [consumeProgrammaticScroll, follow, reconcileReaderScroll, scrollRef]
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
    follow({ kind: 'reveal-latest' })
    scrollToEndWhenMeasurable()
    setShowJump(false)
  }, [follow, scrollToEndWhenMeasurable])

  const scrollToTop = useCallback(() => {
    follow({ kind: 'navigate' })
    // Also where a hidden pane lands once revealed, since the write below waits for layout.
    detachedScrollTopRef.current = 0
    restoreScrollOffset(0)
  }, [follow, restoreScrollOffset])

  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      follow({ kind: 'navigate' })
      alignToViewportTop(element)
    },
    [alignToViewportTop, follow]
  )

  const readerOpened = useCallback(
    (row: string) => {
      follow({ kind: 'open', row })
      syncScrollState()
    },
    [follow, syncScrollState]
  )

  // Read at close time: the pin is rebuilt on a reveal, and every row's toggle hangs off this.
  const scrollToBottomRef = useRef(scrollToBottom)
  useEffect(() => {
    scrollToBottomRef.current = scrollToBottom
  })
  const readerClosed = useCallback(
    (row: string) => {
      const wasFollowing = followRef.current.kind === 'following'
      if (follow({ kind: 'close', row }) && !wasFollowing) {
        scrollToBottomRef.current()
      }
    },
    [follow]
  )

  const untilReaderActs = useCallback((act: () => void) => {
    const acts = readerActsRef.current
    return () => {
      if (readerActsRef.current === acts) {
        act()
      }
    }
  }, [])

  useLayoutEffect(() => {
    const revealed = isVisible && !previousIsVisibleRef.current
    isVisibleRef.current = isVisible
    previousIsVisibleRef.current = isVisible
    if (!isVisible) {
      return
    }
    if (followRef.current.kind !== 'following') {
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
    showsTailRow,
    scrollToEndWhenMeasurable
  ])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (followRef.current.kind === 'following') {
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

  return {
    showJump,
    awayFromTop,
    onScroll,
    scrollToBottom,
    scrollToTop,
    scrollMessageToTop,
    readerOpened,
    readerClosed,
    untilReaderActs
  }
}
