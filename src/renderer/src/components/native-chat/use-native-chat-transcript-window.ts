// Virtualizer owns row anchoring; scroll hook owns follow intent. Use container coordinates and never reattach a parked reader from geometry alone.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { elementScroll, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  NATIVE_CHAT_ROW_GAP_PX,
  type NativeChatRowTypography,
  DEFAULT_ROW_TYPOGRAPHY
} from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import {
  nativeChatScrollOffsetWithin,
  useNativeChatViewportAlign
} from './use-native-chat-viewport-align'

/** Overscan by row because chat rows vary widely in height and rendering cost. */
export const NATIVE_CHAT_WINDOW_OVERSCAN = 6

const FALLBACK_ROW_PX = 48
/** Past this gap the DOM's offset is a write the virtualizer has yet to hear of. */
const UNSEEN_SCROLL_PX = 1
/** Compact retired measurement keys before capped-transcript churn accumulates material stale state. */
export const MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS = 512

export type NativeChatTranscriptWindow = {
  virtualItems: VirtualItem[]
  totalSize: number
  scrollMargin: number
  sizerRef: (node: HTMLDivElement | null) => void
  measureRow: (node: HTMLElement | null) => void
  /** Scroll so this element's top meets the top of the viewport. */
  alignToViewportTop: (element: HTMLElement) => void
  /** Whether a jump is still settling as its target row is measured. */
  isAlignPending: () => boolean
  /** A reader gesture releases the jump's target. */
  cancelAlign: () => void
  /** Pin through the virtualizer’s scroll owner to avoid competing writes; its last-row end includes trailing chrome. */
  scrollToEnd: () => void
  /** Restore a detached reader offset through the virtualizer's scroll owner. */
  restoreScrollOffset: (offset: number) => void
  /** True when this scroll event is the echo of a registered application write. */
  consumeProgrammaticScroll: (event: Event) => boolean
  /** Rebase a pending end reconcile while the reader takes over this frame. */
  reconcileReaderScroll: (isTakingOver: boolean) => void
}

export function useNativeChatTranscriptWindow({
  scrollRef,
  slots,
  isVisible,
  revealIndex,
  newRowsMarkerIndex,
  typography = DEFAULT_ROW_TYPOGRAPHY
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  isVisible: boolean
  /** Slot the transcript was asked to reveal, or -1. */
  revealIndex: number
  /** Slot drawing the "New" marker, or -1. */
  newRowsMarkerIndex?: number
  /** Chat text scale; gap scales with the text size. */
  typography?: NativeChatRowTypography
}): NativeChatTranscriptWindow {
  const sizerElementRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [programmaticScrollMarks] = useState(createProgrammaticScrollMarks)
  const readerTakeoverFrameRef = useRef<number | null>(null)
  const previousMeasurementKeysRef = useRef<ReadonlySet<string> | null>(null)
  const retiredMeasurementCountRef = useRef(0)
  const pinned = useMemo(
    () => nativeChatPinnedRowIndexes({ count: slots.length, revealIndex, newRowsMarkerIndex }),
    [slots.length, revealIndex, newRowsMarkerIndex]
  )
  // Keep measured offsets through content-only growth to preserve the end anchor; rebuild only on structural changes.
  const encodedItemKeys = JSON.stringify(slots.map(nativeChatSlotKey))
  const itemKeys = useMemo(() => JSON.parse(encodedItemKeys) as string[], [encodedItemKeys])
  const estimateSize = useCallback(
    (index: number) => slots[index]?.estimatedHeight ?? FALLBACK_ROW_PX,
    [slots]
  )
  const getItemKey = useCallback((index: number) => itemKeys[index] ?? index, [itemKeys])
  // Pinned-set identity must invalidate cached mounted indexes so reveals mount their row; measurement memoization stays separate.
  const rangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) =>
      nativeChatTranscriptRange(range, pinned),
    [pinned]
  )

  const scaledGapPx = NATIVE_CHAT_ROW_GAP_PX * typography.spacingScale
  // Keep offscreen sizes as estimates through reflows; ResizeObserver refreshes mounted rows.
  const virtualizer = useVirtualizer({
    count: slots.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: NATIVE_CHAT_WINDOW_OVERSCAN,
    gap: scaledGapPx,
    scrollMargin,
    // A hidden pane has no boxes to measure; retain its last visible row sizes.
    useCachedMeasurements: !isVisible,
    anchorTo: 'end',
    followOnAppend: false,
    // Distances are nonnegative: disable geometry-only resize pinning, retaining prepend anchoring.
    scrollEndThreshold: -1,
    // Route measurement/prepend writes through one adapter to track scroll provenance.
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement
      const previous = element?.scrollTop
      elementScroll(offset, options, instance)
      // Capture actual clamped landing before later content growth changes the height; the scroll event arrives asynchronously.
      const landing = element?.scrollTop
      if (previous !== undefined && landing !== undefined && landing !== previous) {
        programmaticScrollMarks.mark(landing)
      }
    }
  })
  const finishReaderTakeover = useCallback(() => {
    if (readerTakeoverFrameRef.current !== null) {
      window.cancelAnimationFrame(readerTakeoverFrameRef.current)
      readerTakeoverFrameRef.current = null
    }
  }, [])
  useEffect(() => finishReaderTakeover, [finishReaderTakeover])

  // Measure actual in-flow predecessors; stale margins misplace every row, so older-history controls stay out of flow.
  const readScrollMargin = useCallback(() => {
    const container = scrollRef.current
    const sizer = sizerElementRef.current
    if (!container || !sizer) {
      return
    }
    // Avoid rect fallback without layout: it reports scrollTop as margin and would pin the window at the transcript’s start.
    const offset = nativeChatScrollOffsetWithin(sizer, container)
    if (offset !== null) {
      setScrollMargin((current) => (current === offset ? current : offset))
    }
  }, [scrollRef])
  useLayoutEffect(readScrollMargin)

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
    return () => observer.disconnect()
  }, [readScrollMargin, scrollRef])

  useLayoutEffect(() => {
    const currentKeys = new Set(itemKeys)
    const previousKeys = previousMeasurementKeysRef.current
    previousMeasurementKeysRef.current = currentKeys
    if (previousKeys !== null) {
      for (const key of previousKeys) {
        if (!currentKeys.has(key)) {
          retiredMeasurementCountRef.current += 1
        }
      }
    }
    if (retiredMeasurementCountRef.current < MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS) {
      return
    }

    const retainedMeasurements = virtualizer
      .takeSnapshot()
      .filter((item) => typeof item.key === 'string' && currentKeys.has(item.key))
    const scrollTop = scrollRef.current?.scrollTop
    virtualizer.measure()
    // Materialize the estimate-only layout before restoring retained sizes.
    virtualizer.getTotalSize()
    for (const item of retainedMeasurements) {
      virtualizer.resizeItem(item.index, item.size)
    }
    if (scrollTop !== undefined) {
      virtualizer.scrollToOffset(scrollTop)
    }
    retiredMeasurementCountRef.current = 0
  }, [itemKeys, scrollRef, virtualizer])

  const sizerRef = useCallback(
    (node: HTMLDivElement | null) => {
      sizerElementRef.current = node
      if (node) {
        readScrollMargin()
      }
    },
    [readScrollMargin]
  )

  const { alignToViewportTop, isAlignPending, endAlign, isAlignHeld } = useNativeChatViewportAlign({
    scrollRef,
    virtualizer,
    finishReaderTakeover,
    programmaticScrollMarks
  })

  // Compensate rows above the reader, excluding visible/first jump-target measurements, unseen scroll writes and backward-reader scrolling; preserve landed jumps.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0
    const written = scrollRef.current?.scrollTop ?? offset
    return (
      Math.abs(written - offset) <= UNSEEN_SCROLL_PX &&
      !(item.index === revealIndex && !instance.itemSizeCache.has(item.key)) &&
      item.end <= offset &&
      (instance.scrollDirection !== 'backward' ||
        !instance.itemSizeCache.has(item.key) ||
        isAlignHeld())
    )
  }

  const scrollToEnd = useCallback(() => {
    const container = scrollRef.current
    if (!isVisible || !container) {
      return
    }
    finishReaderTakeover()
    endAlign()
    // Without windowed rows the virtualizer sees zero height, but unwindowed failure rows may still fill the container.
    if (virtualizer.scrollElement && slots.length > 0) {
      virtualizer.scrollToEnd({ behavior: 'auto' })
      return
    }
    // Use document bottom until layout/windowed rows give the virtualizer a real end target.
    const previous = container.scrollTop
    container.scrollTop = container.scrollHeight
    if (container.scrollTop !== previous) {
      programmaticScrollMarks.mark(container.scrollTop)
    }
  }, [
    endAlign,
    finishReaderTakeover,
    isVisible,
    programmaticScrollMarks,
    scrollRef,
    slots.length,
    virtualizer
  ])

  const restoreScrollOffset = useCallback(
    (offset: number) => {
      const container = scrollRef.current
      if (!isVisible || !container) {
        return
      }
      finishReaderTakeover()
      endAlign()
      if (virtualizer.scrollElement) {
        virtualizer.scrollToOffset(offset, { behavior: 'auto' })
        return
      }
      const previous = container.scrollTop
      container.scrollTop = offset
      if (container.scrollTop !== previous) {
        programmaticScrollMarks.mark(container.scrollTop)
      }
    },
    [endAlign, finishReaderTakeover, isVisible, programmaticScrollMarks, scrollRef, virtualizer]
  )

  const consumeProgrammaticScroll = useCallback(
    (event: Event): boolean => {
      const container = scrollRef.current
      if (!container) {
        return false
      }
      return programmaticScrollMarks.consume(
        event,
        container.scrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight)
      )
    },
    [programmaticScrollMarks, scrollRef]
  )

  const reconcileReaderScroll = useCallback(
    (isTakingOver: boolean) => {
      const container = scrollRef.current
      if (
        !container ||
        !virtualizer.scrollElement ||
        (!isTakingOver && readerTakeoverFrameRef.current === null)
      ) {
        return
      }
      endAlign()
      virtualizer.scrollToOffset(container.scrollTop, { behavior: 'auto' })
      if (readerTakeoverFrameRef.current !== null) {
        return
      }
      // Rebase applies next frame; replace its target until then so every takeover gesture wins.
      readerTakeoverFrameRef.current = window.requestAnimationFrame(() => {
        readerTakeoverFrameRef.current = null
      })
    },
    [endAlign, scrollRef, virtualizer]
  )

  // Release the virtualizer’s held jump target so later measurements cannot undo reader movement.
  const cancelAlign = useCallback(() => {
    if (isAlignHeld()) {
      reconcileReaderScroll(true)
    }
  }, [isAlignHeld, reconcileReaderScroll])

  return {
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollMargin,
    sizerRef,
    measureRow: virtualizer.measureElement,
    alignToViewportTop,
    isAlignPending,
    cancelAlign,
    scrollToEnd,
    restoreScrollOffset,
    consumeProgrammaticScroll,
    reconcileReaderScroll
  }
}
