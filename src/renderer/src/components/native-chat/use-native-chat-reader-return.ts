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
  followingRef: React.RefObject<boolean>
) {
  const input = useRef<ScrollGeometry | null>(null)
  const recordReaderScroll = useCallback(() => {
    input.current = scrollRef.current ? geometryOf(scrollRef.current) : null
  }, [scrollRef])
  const readerReturned = (geometry: ScrollGeometry, programmatic: boolean): boolean => {
    const start = input.current
    if (!start) {
      return false
    }
    if (geometry.clientHeight !== start.clientHeight) {
      input.current = null
      return false
    }
    // Keep reader evidence in the coordinate frame produced by measurements and earlier movement.
    input.current = geometry
    if (programmatic) {
      return false
    }
    if (geometry.scrollHeight < start.scrollHeight) {
      input.current = null
      return false
    }
    if (!followingRef.current || geometry.scrollTop <= start.scrollTop) {
      return false
    }
    input.current = null
    return true
  }
  const readerAtEnd = useCallback(() => {
    const element = scrollRef.current
    return (
      followingRef.current || (hasMeasurableViewport(element) && isNearBottom(geometryOf(element)))
    )
  }, [followingRef, scrollRef])
  return { recordReaderScroll, readerReturned, readerAtEnd }
}
