import { useCallback, useState } from 'react'
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer
} from '@tanstack/react-virtual'

// Why: matches CommandList's `scroll-pt-4 scroll-pb-4`, which cmdk's native reveal honoured.
const COMMAND_LIST_SCROLL_PADDING = 16

function isSameKeySequence(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false
    }
  }
  return true
}

/** Keeps one key array per ordered sequence: TanStack rebuilds every row's geometry whenever its key getter changes. */
function useRetainedKeySequence(itemKeys: readonly string[]): readonly string[] {
  const [retained, setRetained] = useState({ input: itemKeys, keys: itemKeys })
  if (retained.input === itemKeys) {
    return retained.keys
  }
  // Compare each newly supplied array once; equal content keeps the previous identity.
  const keys = isSameKeySequence(retained.keys, itemKeys) ? retained.keys : itemKeys
  setRetained({ input: itemKeys, keys })
  return keys
}

/** Windows a command list whose surface owns selection; the active option stays mounted so aria-activedescendant names a real element. */
export function useWindowedCommandVirtualizer({
  itemKeys,
  scrollElement,
  estimateSize,
  activeIndex,
  overscan,
  enabled = true,
  initialRect,
  initialOffset,
  scrollMargin
}: {
  /** One unique key per row, in order; the row count is its length. */
  itemKeys: readonly string[]
  scrollElement: () => HTMLDivElement | null
  estimateSize: (index: number) => number
  activeIndex: number
  overscan: number
  enabled?: boolean
  initialRect?: Rect
  initialOffset?: () => number
  scrollMargin?: number
}): Virtualizer<HTMLDivElement, Element> {
  const keys = useRetainedKeySequence(itemKeys)
  const count = keys.length
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys])
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
