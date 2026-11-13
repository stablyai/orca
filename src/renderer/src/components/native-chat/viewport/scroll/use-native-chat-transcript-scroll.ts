import { useNativeChatReaderReturn } from './use-native-chat-reader-return'
import { useNativeChatTranscriptResize } from './use-native-chat-transcript-resize'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UIEventHandler } from 'react'
import {
  distanceFromBottom,
  geometryOf,
  hasMeasurableViewport,
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
import type { NativeChatAlignEdge } from '../virtualization/use-native-chat-viewport-align'

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
  reconcileReaderScroll,
  onLeaveEnd,
  onReturnToEnd,
  onReaderScrollDown
}: NativeChatTranscriptScrollOptions): NativeChatTranscriptScroll {
  const [showJump, setShowJump] = useState(false)
  const followingRef = useRef(true)
  const previousGeometryRef = useRef<ScrollGeometry | null>(null)
  const readerReturn = useNativeChatReaderReturn(scrollRef, followingRef, previousGeometryRef)
  const { performApplicationScroll, observeVisibility, readerAtEnd } = readerReturn
  const detachedScrollTopRef = useRef<number | null>(null)
  const isVisibleRef = useRef(isVisible)
  const previousIsVisibleRef = useRef(isVisible)
  const previousDistanceFromEndRef = useRef(Number.POSITIVE_INFINITY)

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
            performApplicationScroll(scrollToEnd)
          }
        })
      })
    }
  }, [clearForwardedScroll, performApplicationScroll, scrollRef, scrollToEnd])
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
    onLeaveEnd?.()
    const element = scrollRef.current
    if (element) {
      previousDistanceFromEndRef.current = distanceFromBottom(geometryOf(element))
    }
    // Replace a pending virtualizer target before the browser applies the gesture.
    reconcileReaderScroll(true)
    syncScrollState()
  }, [clearForwardedScroll, onLeaveEnd, reconcileReaderScroll, scrollRef, syncScrollState])

  const observeForwardedMovement = useCallback(
    (geometry: ScrollGeometry, programmatic: boolean) => {
      const previous = previousGeometryRef.current
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
      const onRead = isAlignPending() ? undefined : onReaderScrollDown
      if (readerReturn.readerReturned(geometry, programmatic, onRead)) {
        onReturnToEnd?.()
      }
    },
    [
      consumeProgrammaticScroll,
      isAlignPending,
      observeForwardedMovement,
      onReaderScrollDown,
      onReturnToEnd,
      readerReturn,
      reconcileReaderScroll,
      scrollRef,
      syncScrollState
    ]
  )

  const scrollToEndWhenMeasurable = useCallback(() => {
    if (isVisibleRef.current && hasMeasurableViewport(scrollRef.current)) {
      if (forwardedInputRef.current || forwardedMovementRef.current) {
        deferredPinRef.current = true
        return
      }
      clearForwardedScroll()
      performApplicationScroll(scrollToEnd)
    }
  }, [clearForwardedScroll, performApplicationScroll, scrollRef, scrollToEnd])

  const scrollToBottom = useCallback(
    (reason?: 'send') => {
      if (!isVisibleRef.current) {
        return
      }
      clearForwardedScroll()
      followingRef.current = true
      scrollToEndWhenMeasurable()
      setShowJump(false)
      onReturnToEnd?.(reason)
    },
    [clearForwardedScroll, onReturnToEnd, scrollToEndWhenMeasurable]
  )

  const scrollMessageToTop = useCallback(
    (element: HTMLElement, edge?: NativeChatAlignEdge) => {
      clearForwardedScroll()
      followingRef.current = false
      onLeaveEnd?.()
      alignToViewportTop(element, edge)
    },
    [alignToViewportTop, clearForwardedScroll, onLeaveEnd]
  )

  useLayoutEffect(() => {
    if (isVisible !== previousIsVisibleRef.current) {
      clearForwardedScroll()
    }
    const revealed = isVisible && !previousIsVisibleRef.current
    isVisibleRef.current = isVisible
    previousIsVisibleRef.current = isVisible
    observeVisibility(isVisible, revealed)
    if (!isVisible) {
      return
    }
    if (!followingRef.current) {
      if (revealed) {
        if (detachedScrollTopRef.current !== null) {
          const offset = detachedScrollTopRef.current
          performApplicationScroll(() => restoreScrollOffset(offset))
        }
        followingRef.current = readerAtEnd(NATIVE_CHAT_FOLLOW_REARM_PX)
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
    performApplicationScroll,
    readerAtEnd,
    observeVisibility,
    restoreScrollOffset,
    scrollRef,
    showsTailRow,
    scrollToEndWhenMeasurable,
    syncScrollState
  ])

  useNativeChatTranscriptResize({
    scrollRef,
    contentRef,
    isVisibleRef,
    observeResize: readerReturn.observeResize,
    followingRef,
    scrollToEndWhenMeasurable,
    syncScrollState
  })

  return {
    showJump,
    recordReaderScroll: readerReturn.recordReaderScroll,
    onScroll,
    scrollToBottom,
    readerAtEnd: readerReturn.readerAtEnd,
    scrollMessageToTop,
    readerLeavesEnd,
    forwardedGesture
  }
}
