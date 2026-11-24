import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { elementScroll, useVirtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import { VIRTUALIZED_LIST_OVERSCAN } from '@/components/ui/virtualized-list'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'

/** A tool line's `min-h-6.5`; measured rows replace it. */
const ROW_ESTIMATE_PX = 26
const estimateRowSize = (): number => ROW_ESTIMATE_PX
const ignoreScroll = (): void => {}
const neverAdjustScroll = (): boolean => false

export type NativeChatToolRunDrawnRow = { index: number; start: number; end: number }

/** The run's virtualizer, kept in its own hook: it reads a mutable library instance every render,
 *  so every live read (window, sizes, positions) happens here and leaves as plain values. */
export function useNativeChatToolRunWindow({
  rows,
  getScrollElement,
  observeOffset,
  isVisible,
  drawsEveryRow,
  rangeExtractor,
  estimateSize = estimateRowSize,
  enabled = true
}: {
  rows: readonly Pick<NativeChatToolRunRow, 'key'>[]
  getScrollElement: () => HTMLDivElement | null
  /** For windows that read member-relative offsets from the transcript, which owns scroll writes. */
  observeOffset?: VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementOffset']
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
    ...(observeOffset
      ? { observeElementOffset: observeOffset, scrollToFn: ignoreScroll }
      : { scrollToFn: elementScroll }),
    estimateSize,
    enabled,
    getItemKey,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    rangeExtractor,
    // A hidden pane has no boxes to measure; keep the last visible sizes.
    useCachedMeasurements: !isVisible
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = observeOffset
    ? neverAdjustScroll
    : undefined
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const measurements = virtualizer.measurementsCache
  // Nothing measurable (a hidden pane): keep what was drawn rather than unmounting the window.
  const lastDrawnRef = useRef<readonly NativeChatToolRunDrawnRow[]>([])
  // Every row drawn: the same array while only the scroll position moves, so the rows are not rebuilt.
  const everyRow = useMemo<readonly NativeChatToolRunDrawnRow[] | null>(
    () =>
      drawsEveryRow
        ? Array.from({ length: rows.length }, (_, index) => ({ index, start: 0, end: 0 }))
        : null,
    [drawsEveryRow, rows.length]
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
    if (windowRows) {
      lastDrawnRef.current = windowRows
    }
  })
  const drawn: readonly NativeChatToolRunDrawnRow[] =
    everyRow ?? windowRows ?? lastDrawnRef.current.filter((row) => row.index < rows.length)
  return { virtualizer, measureRow: virtualizer.measureElement, totalSize, drawn }
}
