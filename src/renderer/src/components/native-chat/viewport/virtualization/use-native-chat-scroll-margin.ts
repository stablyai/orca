import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { nativeChatScrollOffsetWithin } from './use-native-chat-viewport-align'

/** Where the transcript's rows start inside the scroller, for the virtualizer's scroll margin. */
export function useNativeChatScrollMargin(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  isVisible: boolean
): { scrollMargin: number; sizerRef: (node: HTMLDivElement | null) => void } {
  const sizerElementRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  // Measure actual in-flow predecessors; stale margins misplace every row, so older-history controls stay out of flow.
  const readScrollMargin = useCallback(() => {
    const container = scrollRef.current
    const sizer = sizerElementRef.current
    if (!container || !sizer) {
      return
    }
    // Avoid rect fallback without layout: it reports scrollTop as margin and would pin the window at the transcript’s start.
    const offset = nativeChatScrollOffsetWithin(sizer, container)
    if (offset !== null) {
      setScrollMargin((current) => (current === offset ? current : offset))
    }
  }, [scrollRef])
  // A hidden pane is display:none, so read again once it shows.
  useLayoutEffect(() => {
    if (isVisible) {
      readScrollMargin()
    }
  }, [isVisible, readScrollMargin])

  // Only the scroller or the column above the rows (lead content) moves the margin. Observer
  // callbacks run after layout, so reading there forces none, unlike a read after every render.
  const marginObserverRef = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    readScrollMargin()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(readScrollMargin)
    marginObserverRef.current = observer
    observer.observe(container)
    const column = sizerElementRef.current?.parentElement
    if (column) {
      observer.observe(column)
    }
    return () => {
      observer.disconnect()
      marginObserverRef.current = null
    }
  }, [readScrollMargin, scrollRef])

  const sizerRef = useCallback(
    (node: HTMLDivElement | null) => {
      sizerElementRef.current = node
      if (node) {
        readScrollMargin()
        if (node.parentElement) {
          marginObserverRef.current?.observe(node.parentElement)
        }
      }
    },
    [readScrollMargin]
  )

  return { scrollMargin, sizerRef }
}
