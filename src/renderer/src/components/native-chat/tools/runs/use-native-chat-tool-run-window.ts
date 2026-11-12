import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { elementScroll, measureElement, useVirtualizer } from '@tanstack/react-virtual'
import { VIRTUALIZED_LIST_OVERSCAN } from '@/components/virtualized-list'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'

/** A tool line's `min-h-6.5`; measured rows replace it. */
const ROW_ESTIMATE_PX = 26
const estimateRowSize = (): number => ROW_ESTIMATE_PX

export type NativeChatToolRunDrawnRow = { index: number; start: number; end: number }

/** The run's virtualizer, kept in its own hook: it reads a mutable library instance every render,
 *  so every live read (window, sizes, positions) happens here and leaves as plain values. */
export function useNativeChatToolRunWindow({
  rows,
  scrollerRef,
  isVisible,
  drawsEveryRow,
  rangeExtractor,
  marks,
  onMeasure
}: {
  rows: readonly NativeChatToolRunRow[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  isVisible: boolean
  drawsEveryRow: boolean
  rangeExtractor: (range: {
    startIndex: number
    endIndex: number
    overscan: number
    count: number
  }) => number[]
  marks: ProgrammaticScrollMarks
  /** Every real measurement, attach and resize alike, so the cap and follow see them all. */
  onMeasure: (element: HTMLDivElement) => void
}) {
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  // Stable per row list: a new key function makes the virtualizer rebuild every row's measurement.
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: estimateRowSize,
    getItemKey,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    rangeExtractor,
    // A hidden pane has no boxes to measure; keep the last visible sizes.
    useCachedMeasurements: !isVisible,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance)
      onMeasureRef.current(element)
      return size
    },
    // Mark every write the virtualizer makes so the reader's own scrolling stays distinguishable.
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement
      const previous = element?.scrollTop
      elementScroll(offset, options, instance)
      if (element && element.scrollTop !== previous) {
        marks.mark(element.scrollTop)
      }
    }
  })
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const measurements = virtualizer.measurementsCache
  // Nothing measurable (a hidden pane): keep what was drawn rather than unmounting the window.
  const lastDrawnRef = useRef<readonly number[]>([])
  // Every row drawn: the same array while only the scroll position moves, so the rows are not rebuilt.
  const everyRow = useMemo<readonly NativeChatToolRunDrawnRow[] | null>(
    () =>
      drawsEveryRow
        ? Array.from({ length: rows.length }, (_, index) => ({ index, start: 0, end: 0 }))
        : null,
    [drawsEveryRow, rows.length]
  )
  const indexes = everyRow
    ? null
    : virtualItems.length > 0
      ? virtualItems.map((item) => item.index)
      : lastDrawnRef.current.filter((index) => index < rows.length)
  useLayoutEffect(() => {
    if (indexes) {
      lastDrawnRef.current = indexes
    }
  })
  const drawn: readonly NativeChatToolRunDrawnRow[] =
    everyRow ??
    (indexes ?? []).map((index) => ({
      index,
      start: measurements[index]?.start ?? 0,
      end: measurements[index]?.end ?? 0
    }))
  return { virtualizer, measureRow: virtualizer.measureElement, totalSize, drawn }
}
