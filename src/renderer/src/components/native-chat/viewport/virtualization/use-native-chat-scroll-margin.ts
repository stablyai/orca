import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import { nativeChatScrollOffsetWithin } from './use-native-chat-viewport-align'

/** Past this gap the DOM's offset is a write the virtualizer has yet to hear of. */
export const UNSEEN_SCROLL_PX = 1
/** Marks the older-history row; a bot chat's transcript makes room for it below the floating pill. */
const OLDER_HISTORY_ROW_ATTRIBUTE = 'data-native-chat-older-history'

/** Where the transcript's rows start inside the scroller, for the virtualizer's scroll margin. */
export function useNativeChatScrollMargin({
  scrollRef,
  isVisible,
  programmaticScrollMarks,
  scrollOffset
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  isVisible: boolean
  programmaticScrollMarks: ProgrammaticScrollMarks
  /** The virtualizer's scroll offset; the virtualizer is made after the margin it needs. */
  scrollOffset: React.RefObject<(() => number | null | undefined) | null>
}): { scrollMargin: number; sizerRef: (node: HTMLDivElement | null) => void } {
  const sizerElementRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const measuredScrollMargin = useRef(0)
  /** Whether the older-history row showed at the last margin read; null before the first. */
  const hadOlderRow = useRef<boolean | null>(null)
  // Measure actual in-flow predecessors; stale margins misplace every row, so older-history controls stay out of flow.
  const readScrollMargin = useCallback(() => {
    const container = scrollRef.current
    const sizer = sizerElementRef.current
    // Avoid rect fallback without layout: it reports scrollTop as margin and would pin the window at the transcript’s start.
    const offset = container && sizer ? nativeChatScrollOffsetWithin(sizer, container) : null
    if (!container || offset === null) {
      return
    }
    // A bot chat makes room for the older-history row only while it shows. When the row comes or goes,
    // keep the rows the reader sees in place; at the very top there is nothing above to keep.
    // The row renders first in the scroller; reading one child keeps this read O(1).
    const hasOlderRow =
      container.firstElementChild?.hasAttribute(OLDER_HISTORY_ROW_ATTRIBUTE) === true
    const rowToggled = hadOlderRow.current !== null && hasOlderRow !== hadOlderRow.current
    hadOlderRow.current = hasOlderRow
    if (offset === measuredScrollMargin.current) {
      return
    }
    if (rowToggled && container.scrollTop > 0) {
      const previous = container.scrollTop
      // Near the end the shrink has already clamped scrollTop; start from the offset the virtualizer meant.
      const atEnd = previous >= container.scrollHeight - container.clientHeight - UNSEEN_SCROLL_PX
      const meant = scrollOffset.current?.() ?? previous
      const base = atEnd ? Math.max(previous, meant) : previous
      container.scrollTop = base + offset - measuredScrollMargin.current
      if (container.scrollTop !== previous) {
        programmaticScrollMarks.mark(container.scrollTop)
      }
    }
    measuredScrollMargin.current = offset
    setScrollMargin(offset)
  }, [programmaticScrollMarks, scrollOffset, scrollRef])
  // A hidden pane is display:none, so read again once it shows.
  useLayoutEffect(() => {
    if (isVisible) {
      readScrollMargin()
    }
  }, [isVisible, readScrollMargin])

  // Only the scroller or the column above the rows (lead content, and the inset that makes room
  // for the older-history row) moves the margin. Observer callbacks run after layout, so reading
  // there forces none, unlike a read after every render.
  const [sizer, setSizer] = useState<HTMLDivElement | null>(null)
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
    observer.observe(container)
    const column = sizer?.parentElement
    if (column) {
      observer.observe(column)
    }
    // The inset's padding grows when the older-history row shows; only its border box sees that.
    if (column?.parentElement) {
      observer.observe(column.parentElement, { box: 'border-box' })
    }
    return () => observer.disconnect()
  }, [readScrollMargin, scrollRef, sizer])

  const sizerRef = useCallback((node: HTMLDivElement | null) => {
    sizerElementRef.current = node
    setSizer(node)
  }, [])

  return { scrollMargin, sizerRef }
}
