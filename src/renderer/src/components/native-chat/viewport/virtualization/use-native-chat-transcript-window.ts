// Virtualizer owns row anchoring; scroll hook owns follow intent. Use container coordinates and never reattach a parked reader from geometry alone.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { elementScroll, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import {
  NATIVE_CHAT_ROW_GAP_PX,
  type NativeChatRowTypography,
  DEFAULT_ROW_TYPOGRAPHY
} from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'
import { useNativeChatRowMeasure } from './use-native-chat-row-measure'
import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatViewportAlign,
  type NativeChatAlignEdge
} from './use-native-chat-viewport-align'
import { UNSEEN_SCROLL_PX, useNativeChatScrollMargin } from './use-native-chat-scroll-margin'
import { useNativeChatRetiredMeasurements } from './use-native-chat-retired-measurements'

/** Overscan by row because chat rows vary widely in height and rendering cost. */
export const NATIVE_CHAT_WINDOW_OVERSCAN = 6

const FALLBACK_ROW_PX = 48

export type NativeChatTranscriptWindow = {
  virtualItems: VirtualItem[]
  totalSize: number
  scrollMargin: number
  sizerRef: (node: HTMLDivElement | null) => void
  measureRow: React.RefCallback<HTMLDivElement>
  /** Scroll so this element's top meets the top of the viewport. */
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  /** Whether a jump is still settling as its target row is measured. */
  isAlignPending: () => boolean
  /** A reader gesture releases the jump's target. */
  cancelAlign: () => void
  releaseEndPin: () => void
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
  const [programmaticScrollMarks] = useState(createProgrammaticScrollMarks)
  const virtualizerScrollOffset = useRef<(() => number | null | undefined) | null>(null)
  const { scrollMargin, sizerRef } = useNativeChatScrollMargin({
    scrollRef,
    isVisible,
    programmaticScrollMarks,
    scrollOffset: virtualizerScrollOffset
  })
  const readerTakeoverFrameRef = useRef<number | null>(null)
  const pinned = useMemo(
    () => nativeChatPinnedRowIndexes({ count: slots.length, revealIndex, newRowsMarkerIndex }),
    [slots.length, revealIndex, newRowsMarkerIndex]
  )
  // Keep measured offsets through content-only growth to preserve the end anchor; rebuild only on structural changes.
  // Encoded only when the slots change: scroll and range renders reuse it.
  const encodedItemKeys = useMemo(() => JSON.stringify(slots.map(nativeChatSlotKey)), [slots])
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
  const [jumpDrawnAbovePx, setJumpDrawnAbovePx] = useState(0)
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
    scrollPaddingStart: jumpDrawnAbovePx, // A jump's row drawn above its top lands by its first line.
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
  useLayoutEffect(() => {
    virtualizerScrollOffset.current = () => virtualizer.scrollOffset
  }, [virtualizer])
  const finishReaderTakeover = useCallback(() => {
    if (readerTakeoverFrameRef.current !== null) {
      window.cancelAnimationFrame(readerTakeoverFrameRef.current)
      readerTakeoverFrameRef.current = null
    }
  }, [])
  useEffect(() => finishReaderTakeover, [finishReaderTakeover])

  useNativeChatRetiredMeasurements({ itemKeys, scrollRef, virtualizer })

  const {
    alignToViewportTop,
    isAlignPending,
    endAlign,
    isAlignHeld,
    pinsEndGrowth,
    releaseEndPin
  } = useNativeChatViewportAlign({
    scrollRef,
    virtualizer,
    finishReaderTakeover,
    programmaticScrollMarks,
    holdJumpDrawnAbove: setJumpDrawnAbovePx
  })

  // Compensate rows above the reader, excluding visible/first jump-target measurements, unseen scroll writes and backward-reader scrolling; preserve landed jumps.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0
    const written = scrollRef.current?.scrollTop ?? offset
    if (Math.abs(written - offset) > UNSEEN_SCROLL_PX) {
      return false
    }
    if (pinsEndGrowth(item.index, instance.measurementsCache)) {
      return true
    }
    return (
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
    measureRow: useNativeChatRowMeasure(virtualizer, isVisible),
    alignToViewportTop,
    isAlignPending,
    cancelAlign,
    releaseEndPin,
    scrollToEnd,
    restoreScrollOffset,
    consumeProgrammaticScroll,
    reconcileReaderScroll
  }
}
