import { useCallback } from 'react'
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer
} from '@tanstack/react-virtual'

// Why: matches CommandList's `scroll-pt-4 scroll-pb-4`, which cmdk's native reveal honoured.
const COMMAND_LIST_SCROLL_PADDING = 16

/** Windows a command list whose surface owns selection; the active option stays mounted so aria-activedescendant names a real element. */
export function useWindowedCommandVirtualizer({
  count,
  scrollElement,
  estimateSize,
  getItemKey,
  activeIndex,
  overscan,
  enabled = true,
  initialRect,
  initialOffset,
  scrollMargin
}: {
  count: number
  scrollElement: () => HTMLDivElement | null
  estimateSize: (index: number) => number
  getItemKey: (index: number) => string | number
  activeIndex: number
  overscan: number
  enabled?: boolean
  initialRect?: Rect
  initialOffset?: () => number
  scrollMargin?: number
}): Virtualizer<HTMLDivElement, Element> {
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (activeIndex >= 0 && activeIndex < count && !indexes.includes(activeIndex)) {
        indexes.push(activeIndex)
        indexes.sort((a, b) => a - b)
      }
      return indexes
    },
    [activeIndex, count]
  )
  return useVirtualizer({
    count,
    enabled,
    getScrollElement: scrollElement,
    estimateSize,
    getItemKey,
    overscan,
    rangeExtractor,
    initialRect,
    initialOffset,
    scrollMargin,
    scrollPaddingStart: COMMAND_LIST_SCROLL_PADDING,
    scrollPaddingEnd: COMMAND_LIST_SCROLL_PADDING
  })
}
