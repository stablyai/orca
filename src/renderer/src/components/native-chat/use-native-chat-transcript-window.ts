// DOM windowing for the transcript: only the rows near the viewport are mounted,
// the rest are reserved as estimated height.
//
// The virtualizer owns visible-row anchoring; the transcript scroll hook owns
// end-follow intent. Geometry alone must never reattach a parked reader.
//
// Measurements and scroll offsets share the container's coordinate space.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { elementScroll, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { NATIVE_CHAT_ROW_GAP_PX } from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import {
  nativeChatScrollOffsetWithin,
  useNativeChatViewportAlign
} from './use-native-chat-viewport-align'

/** Rows kept mounted past each edge of the viewport. Chat rows are tall and
 *  arbitrarily expensive, so this buys smoothness by the row, not by the screen. */
export const NATIVE_CHAT_WINDOW_OVERSCAN = 6

const FALLBACK_ROW_PX = 48
/** Past this gap the DOM's offset is a write the virtualizer has yet to hear of. */
const UNSEEN_SCROLL_PX = 1
/** Retired keys are harmless to layout but otherwise accumulate for the pane's
 *  lifetime as a capped transcript advances. Compact them well before the stale
 *  entries become material compared with the live window. */
export const MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS = 512

export type NativeChatTranscriptWindow = {
  virtualItems: VirtualItem[]
  totalSize: number
  scrollMargin: number
  sizerRef: (node: HTMLDivElement | null) => void
  measureRow: (node: HTMLElement | null) => void
  /** Scroll so this element's top meets the top of the viewport. */
  alignToViewportTop: (element: HTMLElement) => void
  /** Whether that scroll is still travelling: true until the view reaches its
   *  target, or another write or the reader takes the scroll from it. */
  isAlignPending: () => boolean
  /** A reader gesture that scrolls the transcript ends a scroll still travelling. */
  cancelAlign: () => void
  /** Pin to the transcript's end. Through the virtualizer for the same reason
   *  the reveal is: it owns the offset, and a write it does not recognise as its
   *  own is a reconcile it will fight. Its last-item `end` target is the
   *  browser's real max scroll, so this lands where the document bottom is,
   *  trailing chrome included. */
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
  revealIndex
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  isVisible: boolean
  /** Slot the transcript was asked to reveal, or -1. */
  revealIndex: number
}): NativeChatTranscriptWindow {
  const sizerElementRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [programmaticScrollMarks] = useState(createProgrammaticScrollMarks)
  const readerTakeoverFrameRef = useRef<number | null>(null)
  const previousMeasurementKeysRef = useRef<ReadonlySet<string> | null>(null)
  const retiredMeasurementCountRef = useRef(0)
  const pinned = useMemo(
    () => nativeChatPinnedRowIndexes({ count: slots.length, revealIndex }),
    [slots.length, revealIndex]
  )
  // A content-only tail revision must not rebuild measured offsets: doing so
  // breaks the end anchor while the row grows. Structural changes replace it.
  const encodedItemKeys = JSON.stringify(slots.map(nativeChatSlotKey))
  const itemKeys = useMemo(() => JSON.parse(encodedItemKeys) as string[], [encodedItemKeys])
  const estimateSize = useCallback(
    (index: number) => slots[index]?.estimatedHeight ?? FALLBACK_ROW_PX,
    [slots]
  )
  const getItemKey = useCallback((index: number) => itemKeys[index] ?? index, [itemKeys])
  // Identity tracks the pinned set on purpose. The virtualizer memoizes the
  // mounted indexes on this function, so a stable one would keep serving the
  // range from before a row was pinned — and a reveal would point at a row that
  // never mounted. It is not a dependency of the measurement memo, so nothing
  // expensive is rebuilt by changing it.
  const rangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) =>
      nativeChatTranscriptRange(range, pinned),
    [pinned]
  )

  const virtualizer = useVirtualizer({
    count: slots.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: NATIVE_CHAT_WINDOW_OVERSCAN,
    gap: NATIVE_CHAT_ROW_GAP_PX,
    scrollMargin,
    anchorTo: 'end',
    followOnAppend: false,
    // Distances are nonnegative: disable geometry-only resize pinning, retaining prepend anchoring.
    scrollEndThreshold: -1,
    // Every virtualizer write uses this public adapter, including measurement
    // adjustments and prepend anchoring, so scroll events have one provenance.
    scrollToFn: (offset, options, instance) => {
      const target = offset + (options.adjustments ?? 0)
      const element = instance.scrollElement
      if (options.behavior === 'smooth') {
        if (element) {
          const max = Math.max(0, element.scrollHeight - element.clientHeight)
          const landing = Math.max(0, Math.min(target, max))
          if (element.scrollTop !== landing) {
            programmaticScrollMarks.mark(landing)
          }
        }
        elementScroll(offset, options, instance)
        return
      }
      const previous = element?.scrollTop
      elementScroll(offset, options, instance)
      // Scroll events dispatch later; read back now so a clamp against the old
      // document height stays attributable if content grows before its echo.
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

  // Read, never assumed: whatever sits in flow above the window decides it, and
  // a stale margin places every row wrong. The older-history row is kept out of
  // flow for exactly that reason — it leaves as the last prepend lands.
  const readScrollMargin = useCallback(() => {
    const container = scrollRef.current
    const sizer = sizerElementRef.current
    if (!container || !sizer) {
      return
    }
    // Only the offset chain, never the rect fallback: a container with no
    // layout would report the scroll position itself as the margin, which would
    // hold the window at the top of the transcript no matter where it scrolled.
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

  // Preserve rows above the reader, never compensate growth within the visible
  // row — including its first measurement, which may follow an exact estimate.
  // Nor the first measurement of a jump's target row: at the end its correction is
  // clamped, and the virtualizer retries it after the jump starts, cancelling it.
  // Nor while the virtualizer has not seen a scroll just written: it corrects from
  // the offset it last heard, which would put the view back where the write left.
  // A row re-measured during a backward scroll is left alone, so rows do not jump
  // under a reader scrolling up; a jump that landed is not that reader, and a row
  // growing above it would otherwise push its message down for good.
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
    // With no windowed row it would resolve the end from its own rows' height, 0, though rows
    // drawn after the window (a message shown as not sent) still fill the container.
    if (virtualizer.scrollElement && slots.length > 0) {
      virtualizer.scrollToEnd({ behavior: 'auto' })
      return
    }
    // No virtualizer yet (a container without layout), or no windowed row: the document's own
    // bottom is the same offset the virtualizer would resolve for the last row.
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
      // The public rebase itself reconciles on the next frame. Keep replacing its
      // target until that frame so every reader move in the takeover wins.
      readerTakeoverFrameRef.current = window.requestAnimationFrame(() => {
        readerTakeoverFrameRef.current = null
      })
    },
    [endAlign, scrollRef, virtualizer]
  )

  // The virtualizer still holds the jump's row as its target, and would write it
  // again as rows measure: rebase it onto where the reader is.
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
