import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { elementScroll, useVirtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import { VIRTUALIZED_LIST_OVERSCAN } from '@/components/ui/virtualized-list'
import type { NativeChatToolRunScroll } from '../../viewport/scroll/native-chat-transcript-scroll-context'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'

/** A tool line's `min-h-6.5`; measured rows replace it. */
const ROW_ESTIMATE_PX = 26
const estimateRowSize = (): number => ROW_ESTIMATE_PX

export type NativeChatToolRunDrawnRow = { index: number; start: number; end: number }

/** The run's virtualizer, kept in its own hook: it reads a mutable library instance every render,
 *  so every live read (window, sizes, positions) happens here and leaves as plain values. */
export function useNativeChatToolRunWindow({
  rows,
  getScrollElement,
  transcript,
  initialMeasurementsCache,
  isVisible,
  drawsEveryRow,
  rangeExtractor,
  estimateSize = estimateRowSize,
  enabled = true
}: {
  rows: readonly Pick<NativeChatToolRunRow, 'key'>[]
  getScrollElement: () => HTMLDivElement | null
  /** For windows that read member-relative offsets from the transcript, which owns scroll writes. */
  transcript?: Pick<NativeChatToolRunScroll, 'canAdjustToolRunScroll' | 'adjustToolRunScroll'> & {
    observeOffset: VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementOffset']
  }
  initialMeasurementsCache?: VirtualizerOptions<
    HTMLDivElement,
    HTMLDivElement
  >['initialMeasurementsCache']
  isVisible: boolean
  drawsEveryRow: boolean
  rangeExtractor: (range: {
    startIndex: number
    endIndex: number
    overscan: number
    count: number
  }) => number[]
  estimateSize?: (index: number) => number
  enabled?: boolean
}) {
  // Stable per row list: a new key function makes the virtualizer rebuild every row's measurement.
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement,
    ...(transcript
      ? {
          observeElementOffset: transcript.observeOffset,
          scrollToFn: (_offset, { adjustments }) => {
            if (adjustments) {
              transcript.adjustToolRunScroll(adjustments)
            }
          }
        }
      : { scrollToFn: elementScroll }),
    initialMeasurementsCache: initialMeasurementsCache ?? [],
    estimateSize,
    enabled,
    getItemKey,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    rangeExtractor,
    // A hidden pane has no boxes to measure; keep the last visible sizes.
    useCachedMeasurements: !isVisible
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = transcript
    ? (item, _delta, instance) => {
        const offset = instance.scrollOffset ?? 0
        // Use inner anchoring only while the reader is inside the run.
        return (
          offset > 0 &&
          item.end <= offset &&
          offset < instance.getTotalSize() &&
          transcript.canAdjustToolRunScroll()
        )
      }
    : undefined
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const measurements = virtualizer.measurementsCache
  // Nothing measurable (a hidden pane): keep what was drawn rather than unmounting the window.
  const lastDrawnRef = useRef<readonly NativeChatToolRunDrawnRow[]>([])
  const drewEveryRowRef = useRef(false)
  // Keep keyed rows mounted until a growing list has its first measured window.
  const drawsAll = drawsEveryRow || (virtualItems.length === 0 && drewEveryRowRef.current)
  // Every row drawn: the same array while only the scroll position moves, so the rows are not rebuilt.
  const everyRow = useMemo<readonly NativeChatToolRunDrawnRow[] | null>(
    () =>
      drawsAll
        ? Array.from({ length: rows.length }, (_, index) => ({ index, start: 0, end: 0 }))
        : null,
    [drawsAll, rows.length]
  )
  // The window's rows keep their identity while the virtualizer's items and sizes do, so an
  // unchanged window (a large selection span, say) re-renders no rows.
  const windowRows = useMemo<readonly NativeChatToolRunDrawnRow[] | null>(
    () =>
      everyRow || virtualItems.length === 0
        ? null
        : virtualItems.map((item) => ({
            index: item.index,
            start: measurements[item.index]?.start ?? 0,
            end: measurements[item.index]?.end ?? 0
          })),
    [everyRow, measurements, virtualItems]
  )
  useLayoutEffect(() => {
    drewEveryRowRef.current = drawsAll
    if (windowRows) {
      lastDrawnRef.current = windowRows
    }
  })
  const drawn: readonly NativeChatToolRunDrawnRow[] =
    everyRow ?? windowRows ?? lastDrawnRef.current.filter((row) => row.index < rows.length)
  return {
    virtualizer,
    measureRow: virtualizer.measureElement,
    totalSize,
    drawn,
    drawsEveryRow: drawsAll
  }
}
