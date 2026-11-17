import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { BuildLogBuffer } from './build-log-model'
import { rowKeyAt, rowSizeAt, type Segment } from './log-row-layout'

export const LINE_ROW_PX = 20
/** Two line heights, so every row (and the viewport) is a whole number of lines. */
export const HEADER_ROW_PX = 2 * LINE_ROW_PX

// Round measured rows (wrapped lines, error callouts) up to whole lines: with the viewport a
// multiple of a line too, a top- or bottom-aligned scroll never shows half a row.
const measureWholeLines = (element: Element): number =>
  Math.ceil(element.getBoundingClientRect().height / LINE_ROW_PX) * LINE_ROW_PX

/**
 * The log's virtualizer with stable, allocation-free callbacks. virtual-core rebuilds every row's
 * measurements whenever estimateSize/getItemKey change identity, so inline callbacks would cost
 * O(lines) on every render, scroll frame and clock tick. These read the latest layout from refs.
 */
export function useLogVirtualizer(
  segments: readonly Segment[],
  buffer: BuildLogBuffer,
  rowCount: number,
  scrollRef: RefObject<HTMLDivElement | null>
): Virtualizer<HTMLDivElement, Element> {
  const layout = useRef({ segments, buffer })
  // Read synchronously by the virtualizer during this same render, so a layout effect is too late.
  layout.current = { segments, buffer }

  const estimateSize = useCallback(
    (index: number) => rowSizeAt(layout.current.segments, index, HEADER_ROW_PX, LINE_ROW_PX),
    []
  )
  const getItemKey = useCallback(
    (index: number) => rowKeyAt(layout.current.segments, layout.current.buffer, index),
    []
  )
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef])

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 24,
    measureElement: measureWholeLines
  })

  // Stable callbacks mean virtual-core only re-measures when the count changes. Expanding one step
  // while collapsing another can keep the count and still move every key, so re-measure then.
  const shape = segments.map((segment) => `${segment.step.id}:${segment.rowCount}`).join('|')
  const lastShape = useRef(shape)
  useLayoutEffect(() => {
    if (lastShape.current !== shape) {
      lastShape.current = shape
      virtualizer.measure()
    }
  }, [shape, virtualizer])

  return virtualizer
}
