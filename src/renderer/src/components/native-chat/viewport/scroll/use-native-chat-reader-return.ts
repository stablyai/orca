import { useCallback, useRef } from 'react'
import {
  geometryOf,
  hasMeasurableViewport,
  isNearBottom,
  type ScrollGeometry
} from './native-chat-autoscroll'

/** Browser clamps also scroll; only a reader's movement may release browsed history. */
export function useNativeChatReaderReturn(
  scrollRef: React.RefObject<HTMLElement | null>,
  followingRef: React.RefObject<boolean>,
  previousGeometryRef: React.RefObject<ScrollGeometry | null>
) {
  const input = useRef(false)
  const recordReaderScroll = useCallback(() => {
    input.current = true
  }, [])
  const observeGeometry = useCallback(
    (geometry: ScrollGeometry, programmatic: boolean): ScrollGeometry | null => {
      const previous = previousGeometryRef.current
      previousGeometryRef.current = geometry
      if (
        !previous ||
        geometry.clientHeight !== previous.clientHeight ||
        (!programmatic && geometry.scrollHeight < previous.scrollHeight)
      ) {
        input.current = false
        return null
      }
      return previous
    },
    [previousGeometryRef]
  )
  const observeVisibility = useCallback(
    (isVisible: boolean, revealed: boolean) => {
      if (!isVisible) {
        input.current = false
        previousGeometryRef.current = null
      } else if (revealed || previousGeometryRef.current === null) {
        input.current = false
        const element = scrollRef.current
        previousGeometryRef.current = hasMeasurableViewport(element) ? geometryOf(element) : null
      }
    },
    [previousGeometryRef, scrollRef]
  )
  const observeResize = useCallback(
    (geometry: ScrollGeometry) => {
      const previous = previousGeometryRef.current
      // A moved offset still owes its classified scroll event, including measurement compensation.
      if (previous && geometry.scrollTop !== previous.scrollTop) {
        return
      }
      observeGeometry(geometry, false)
    },
    [observeGeometry, previousGeometryRef]
  )
  const performApplicationScroll = useCallback(
    (write: () => void) => {
      const element = scrollRef.current
      const previous = element?.scrollTop
      write()
      // A no-op pin leaves pending native movement for its classified scroll event.
      if (hasMeasurableViewport(element) && element.scrollTop !== previous) {
        observeGeometry(geometryOf(element), true)
      }
    },
    [observeGeometry, scrollRef]
  )
  const readerReturned = (geometry: ScrollGeometry, programmatic: boolean): boolean => {
    const start = observeGeometry(geometry, programmatic)
    if (
      !start ||
      !input.current ||
      programmatic ||
      !followingRef.current ||
      geometry.scrollTop <= start.scrollTop
    ) {
      return false
    }
    input.current = false
    return true
  }
  const readerAtEnd = useCallback(
    (threshold?: number) => {
      const element = scrollRef.current
      return (
        followingRef.current ||
        (hasMeasurableViewport(element) && isNearBottom(geometryOf(element), threshold))
      )
    },
    [followingRef, scrollRef]
  )
  return {
    recordReaderScroll,
    readerReturned,
    readerAtEnd,
    observeVisibility,
    observeResize,
    performApplicationScroll
  }
}
