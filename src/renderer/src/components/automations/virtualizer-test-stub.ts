/** happy-dom measures zero height; render a bounded window that moves only on scrollToIndex so deferred-focus tests require scrolling to mount offscreen rows. */

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
