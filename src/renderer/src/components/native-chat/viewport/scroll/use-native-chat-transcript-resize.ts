import { useEffect, type RefObject } from 'react'
import { geometryOf, type ScrollGeometry } from './native-chat-autoscroll'

export function useNativeChatTranscriptResize({
  scrollRef,
  contentRef,
  isVisibleRef,
  observeResize,
  followingRef,
  scrollToEndWhenMeasurable,
  syncScrollState
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  isVisibleRef: RefObject<boolean>
  observeResize: (geometry: ScrollGeometry) => void
  followingRef: RefObject<boolean>
  scrollToEndWhenMeasurable: () => void
  syncScrollState: () => ScrollGeometry | null
}) {
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!isVisibleRef.current) {
        return
      }
      observeResize(geometryOf(element))
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
  }, [
    contentRef,
    scrollRef,
    scrollToEndWhenMeasurable,
    syncScrollState,
    isVisibleRef,
    observeResize,
    followingRef
  ])
}
