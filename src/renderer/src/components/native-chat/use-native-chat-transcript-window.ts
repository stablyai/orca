// DOM windowing for the transcript: only the rows near the viewport are mounted,
// the rest are reserved as estimated height.
//
// Anchoring is the library's, not ours. `anchorTo: 'end'` captures the row at the
// current offset before a count change and re-resolves its position afterwards,
// which is what keeps a "load earlier" prepend from yanking the view;
// `followOnAppend` + `scrollEndThreshold` keep a reader who is already at the
// bottom pinned there as a turn streams.
//
// Every measurement here ends up in the scroll container's own coordinate space,
// which means `offsetTop` / `offsetHeight` rather than a bounding rect. The
// transcript is zoomable, and a rect is in viewport pixels while `scrollTop` is
// not: mixing the two puts the window out of place by exactly the zoom factor.
// One path does read rects, and it converts them back before using them.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import { NATIVE_CHAT_ROW_GAP_PX } from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Rows kept mounted past each edge of the viewport. Chat rows are tall and
 *  arbitrarily expensive, so this buys smoothness by the row, not by the screen. */
export const NATIVE_CHAT_WINDOW_OVERSCAN = 6

const FALLBACK_ROW_PX = 48
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
}

/** Distance from a container's scroll origin down to a descendant, in the
 *  container's own scroll pixels, or null when there is no chain to walk.
 *  Absolutely positioned windowed rows are placed with `top`, never a transform,
 *  so `offsetTop` stays true through the window as well. */
export function nativeChatScrollOffsetWithin(
  element: HTMLElement,
  container: HTMLElement
): number | null {
  let top = 0
  let node: HTMLElement | null = element
  while (node !== null && node !== container) {
    top += node.offsetTop
    // A DOM without layout has no `offsetParent` at all; that ends the chain
    // rather than walking into nothing, and the caller reads the null as
    // "cannot place this yet".
    const parent = node.offsetParent as HTMLElement | null | undefined
    node = parent && typeof parent.offsetTop === 'number' ? parent : null
  }
  return node === container ? top : null
}

/** Same distance read off rects, for the case where there is no `offsetParent`
 *  chain to walk. Rects are viewport pixels, so the container's own measured
 *  zoom converts them back; a container with no layout reports no zoom and no
 *  distance, which leaves the offset where it already is. */
function rectOffsetWithin(element: HTMLElement, container: HTMLElement): number {
  const containerRect = container.getBoundingClientRect()
  const zoom =
    container.offsetHeight > 0 && containerRect.height > 0
      ? containerRect.height / container.offsetHeight
      : 1
  return container.scrollTop + (element.getBoundingClientRect().top - containerRect.top) / zoom
}

export function useNativeChatTranscriptWindow({
  scrollRef,
  slots,
  revealIndex
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  /** Slot the transcript was asked to reveal, or -1. */
  revealIndex: number
}): NativeChatTranscriptWindow {
  const sizerElementRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const previousMeasurementKeysRef = useRef<ReadonlySet<string> | null>(null)
  const retiredMeasurementCountRef = useRef(0)
  const pinned = useMemo(
    () => nativeChatPinnedRowIndexes({ count: slots.length, revealIndex }),
    [slots.length, revealIndex]
  )
  // A content-only tail revision must not rebuild measured offsets: doing so
  // breaks the end anchor while the row grows. Structural changes replace it.
  const encodedItemKeys = JSON.stringify(slots.map((slot) => slot.message.id))
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
    followOnAppend: true,
    scrollEndThreshold: NATIVE_CHAT_BOTTOM_THRESHOLD_PX
  })

  // Read, never assumed: the "load earlier" button sits above the window and
  // appears exactly when a prepend is about to land, which is the one moment a
  // stale margin would place every row wrong.
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

  const alignToViewportTop = useCallback(
    (element: HTMLElement) => {
      const container = scrollRef.current
      if (!container) {
        return
      }
      const top =
        nativeChatScrollOffsetWithin(element, container) ?? rectOffsetWithin(element, container)
      // Through the virtualizer so a scroll it is still reconciling — the jump
      // that mounted this row in the first place — is replaced rather than raced.
      if (virtualizer.scrollElement) {
        virtualizer.scrollToOffset(top, { align: 'start', behavior: 'smooth' })
      } else {
        container.scrollTo({ top, behavior: 'smooth' })
      }
    },
    [scrollRef, virtualizer]
  )

  return {
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollMargin,
    sizerRef,
    measureRow: virtualizer.measureElement,
    alignToViewportTop
  }
}
