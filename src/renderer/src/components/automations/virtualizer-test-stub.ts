/**
 * happy-dom reports a zero-height scroll element, and `observeElementRect` hands
 * that measurement straight to the virtualizer — so the real `useVirtualizer`
 * renders no rows at all under test. This stub renders a bounded window instead,
 * which is what the virtualization assertions are actually about.
 *
 * The window starts at index 0 and only moves when `scrollToIndex` names an index
 * outside it, so a row below the fold stays unmounted until the component scrolls
 * to it — the sequence a deferred-focus path depends on.
 */

import { useState } from 'react'

export const VIRTUALIZER_STUB_WINDOW_SIZE = 21

type VirtualizerStubOptions = {
  count: number
  estimateSize: (index: number) => number
  getItemKey?: (index: number) => string | number
}

type VirtualizerStub = {
  getTotalSize: () => number
  getVirtualItems: () => { index: number; key: string | number; start: number; size: number }[]
  measureElement: (element: Element | null) => void
  scrollToIndex: (index: number) => void
}

export function createVirtualizerStub(
  windowSize = VIRTUALIZER_STUB_WINDOW_SIZE
): (options: VirtualizerStubOptions) => VirtualizerStub {
  return ({ count, estimateSize, getItemKey }) => {
    const [windowStart, setWindowStart] = useState(0)
    const sizes = Array.from({ length: count }, (_, index) => estimateSize(index))
    let offset = 0
    const starts = sizes.map((size) => {
      const start = offset
      offset += size
      return start
    })
    return {
      getTotalSize: () => sizes.reduce((total, size) => total + size, 0),
      getVirtualItems: () =>
        Array.from(
          { length: Math.max(0, Math.min(windowSize, count - windowStart)) },
          (_, position) => {
            const index = windowStart + position
            return {
              index,
              key: getItemKey?.(index) ?? index,
              start: starts[index] ?? 0,
              size: sizes[index] ?? 0
            }
          }
        ),
      measureElement: () => undefined,
      // Scrolls the least the target allows, like `align: 'auto'`.
      scrollToIndex: (index: number) => {
        setWindowStart((current) => {
          const lastStart = Math.max(0, count - windowSize)
          if (index < current) {
            return Math.min(index, lastStart)
          }
          if (index >= current + windowSize) {
            return Math.min(index - windowSize + 1, lastStart)
          }
          return current
        })
      }
    }
  }
}
