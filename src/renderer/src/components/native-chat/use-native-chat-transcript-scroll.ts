// Virtualizer measurements move content without reader input; route pin writes through it and detach only on reader gestures/row jumps.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UIEventHandler } from 'react'
import {
  distanceFromBottom,
  isNearBottom,
  NATIVE_CHAT_FOLLOW_REARM_PX,
  nextFollowingEnd,
  readerGestureDirection,
  type ReaderGesture,
  shouldShowJumpToLatest,
  type ScrollGeometry
} from './native-chat-autoscroll'
import type {
  NativeChatTranscriptScroll,
  NativeChatTranscriptScrollOptions
} from './native-chat-transcript-scroll-types'

export type { NativeChatTranscriptScroll } from './native-chat-transcript-scroll-types'

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
}: NativeChatTranscriptScrollOptions): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const followingRef = useRef(true)
  const detachedScrollTopRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  const previousIsVisibleRef = useRef(isVisible)
  const previousDistanceFromEndRef = useRef(Number.POSITIVE_INFINITY)

  const previousGeometryRef = useRef<ScrollGeometry | null>(null)
  const forwardedInputRef = useRef(false)
  const forwardedMovementRef = useRef(false)
  const deferredPinRef = useRef(false)
  const forwardedFrameRef = useRef<number | null>(null)
  const clearForwardedScroll = useCallback(() => {
    forwardedInputRef.current = false
    forwardedMovementRef.current = false
    deferredPinRef.current = false
    if (forwardedFrameRef.current !== null) {
      window.cancelAnimationFrame(forwardedFrameRef.current)
      forwardedFrameRef.current = null
    }
  }, [])
  const invalidateForwardedGesture = useCallback(() => {
    forwardedInputRef.current = false
    forwardedMovementRef.current = false
    // A cancelled gesture still owes the following reader any growth held for it.
    if (!deferredPinRef.current) {
      clearForwardedScroll()
    }
  }, [clearForwardedScroll])
  const expireForwardedScroll = useCallback(() => {
    if (forwardedFrameRef.current === null) {
      // A scroll and its cross-frame input report may arrive in either order.
      forwardedFrameRef.current = window.requestAnimationFrame(() => {
        forwardedFrameRef.current = window.requestAnimationFrame(() => {
          const resumePin = deferredPinRef.current && followingRef.current
          clearForwardedScroll()
          const element = scrollRef.current
          if (resumePin && isVisibleRef.current && hasMeasurableViewport(element)) {
            scrollToEnd()
            previousGeometryRef.current = geometryOf(element)
          }
        })
      })
    }
  }, [clearForwardedScroll, scrollRef, scrollToEnd])
  useEffect(() => clearForwardedScroll, [clearForwardedScroll])

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
    clearForwardedScroll()
    followingRef.current = false
    const element = scrollRef.current
    if (element) {
      previousDistanceFromEndRef.current = distanceFromBottom(geometryOf(element))
    }
    // Replace a pending virtualizer target before the browser applies the gesture.
    reconcileReaderScroll(true)
    syncScrollState()
  }, [clearForwardedScroll, reconcileReaderScroll, scrollRef, syncScrollState])

  const observeForwardedMovement = useCallback(
    (geometry: ScrollGeometry, programmatic: boolean) => {
      const previous = previousGeometryRef.current
      previousGeometryRef.current = geometry
      if (!followingRef.current) {
        clearForwardedScroll()
        return
      }
      if (programmatic || isAlignPending()) {
        invalidateForwardedGesture()
        return
      }
      if (
        !previous ||
        geometry.scrollHeight - geometry.clientHeight <
          previous.scrollHeight - previous.clientHeight
      ) {
        return
      }
      if (
        geometry.scrollTop < previous.scrollTop &&
        !isNearBottom(geometry, NATIVE_CHAT_FOLLOW_REARM_PX)
      ) {
        forwardedMovementRef.current = true
        expireForwardedScroll()
      } else if (geometry.scrollTop > previous.scrollTop) {
        invalidateForwardedGesture()
      }
      if (forwardedInputRef.current && forwardedMovementRef.current) {
        readerLeavesEnd()
      }
    },
    [
      clearForwardedScroll,
      expireForwardedScroll,
      invalidateForwardedGesture,
      isAlignPending,
      readerLeavesEnd
    ]
  )

  const forwardedGesture = useCallback(
    (gesture: ReaderGesture) => {
      const element = scrollRef.current
      if (!followingRef.current || !isVisibleRef.current || !hasMeasurableViewport(element)) {
        clearForwardedScroll()
        return
      }
      if (gesture.kind !== 'touch-drag' && readerGestureDirection(gesture) >= 0) {
        invalidateForwardedGesture()
        return
      }
      forwardedInputRef.current = true
      expireForwardedScroll()
      if (
        forwardedMovementRef.current &&
        !isNearBottom(geometryOf(element), NATIVE_CHAT_FOLLOW_REARM_PX)
      ) {
        readerLeavesEnd()
      } else {
        forwardedMovementRef.current = false
        reconcileReaderScroll(true)
      }
    },
    [
      clearForwardedScroll,
      expireForwardedScroll,
      invalidateForwardedGesture,
      readerLeavesEnd,
      reconcileReaderScroll,
      scrollRef
    ]
  )

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const element = scrollRef.current
      if (!isVisibleRef.current || !hasMeasurableViewport(element)) {
        return
      }
      const geometry = geometryOf(element)
      const programmatic = consumeProgrammaticScroll(event.nativeEvent)
      observeForwardedMovement(geometry, programmatic)
      followingRef.current = nextFollowingEnd({
        following: followingRef.current,
        programmatic,
        geometry,
        previousDistanceFromEnd: previousDistanceFromEndRef.current,
        settling: isAlignPending()
      })
      reconcileReaderScroll(false)
      previousDistanceFromEndRef.current = distanceFromBottom(geometry)
      syncScrollState()
    },
    [
      consumeProgrammaticScroll,
      isAlignPending,
      observeForwardedMovement,
      reconcileReaderScroll,
      scrollRef,
      syncScrollState
    ]
  )

  const scrollToEndWhenMeasurable = useCallback(() => {
    if (isVisibleRef.current && hasMeasurableViewport(scrollRef.current)) {
      if (forwardedInputRef.current || forwardedMovementRef.current) {
        deferredPinRef.current = true
        previousGeometryRef.current = geometryOf(scrollRef.current)
        return
      }
      clearForwardedScroll()
      scrollToEnd()
      previousGeometryRef.current = geometryOf(scrollRef.current)
    }
  }, [clearForwardedScroll, scrollRef, scrollToEnd])

  const scrollToBottom = useCallback(() => {
    // A hidden pane is not where the reader is; it keeps its position for their return.
    if (!isVisibleRef.current) {
      return
    }
    clearForwardedScroll()
    followingRef.current = true
    scrollToEndWhenMeasurable()
    setShowJump(false)
  }, [clearForwardedScroll, scrollToEndWhenMeasurable])

  const scrollMessageToTop = useCallback(
    (element: HTMLElement) => {
      clearForwardedScroll()
      followingRef.current = false
      alignToViewportTop(element)
    },
    [alignToViewportTop, clearForwardedScroll]
  )

  useLayoutEffect(() => {
    if (isVisible !== previousIsVisibleRef.current) {
      clearForwardedScroll()
    }
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
    clearForwardedScroll,
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
      previousGeometryRef.current = geometryOf(element)
      // Growth, an opened row included, keeps a following reader at the end.
      if (followingRef.current) {
        scrollToEndWhenMeasurable()
      }
      syncScrollState()
    })
    // Observe content growth as well as viewport reflows; fixed viewport size misses streaming height changes.
    observer.observe(element)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }
    return () => observer.disconnect()
  }, [clearForwardedScroll, contentRef, scrollRef, scrollToEndWhenMeasurable, syncScrollState])

  return {
    showJump,
    onScroll,
    scrollToBottom,
    scrollMessageToTop,
    readerLeavesEnd,
    forwardedGesture
  }
}
