// DOM windowing for the transcript: only the rows near the viewport are mounted,
// the rest are reserved as estimated height.
//
// Anchoring is the library's, not ours. `anchorTo: 'end'` captures the row at the
// current offset before a count change and re-resolves its position afterwards,
// which is what keeps a "load earlier" prepend from yanking the view;
// `followOnAppend` + `scrollEndThreshold` keep a reader who is already at the
// bottom pinned there as a turn streams.
//
// Every measurement here is in the scroll container's own coordinate space —
// `offsetTop` / `offsetHeight`, never `getBoundingClientRect`. The transcript is
// zoomable, and a rect is in viewport pixels while `scrollTop` is not: mixing
// them puts the window in the wrong place by exactly the zoom factor.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import { NATIVE_CHAT_ROW_GAP_PX } from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Rows kept mounted past each edge of the viewport. Chat rows are tall and
 *  arbitrarily expensive, so this buys smoothness by the row, not by the screen. */
export const NATIVE_CHAT_WINDOW_OVERSCAN = 6

/** Below this the scroll root cannot tell us where the viewport is, so windowing
 *  would be guessing. A collapsed or not-yet-laid-out pane reads as 0. */
export const MIN_WINDOWED_VIEWPORT_PX = 32

const FALLBACK_ROW_PX = 48

export type NativeChatTranscriptWindow = {
  /** False means the caller must render every row itself, in normal flow. */
  isWindowed: boolean
  virtualItems: VirtualItem[]
  totalSize: number
  scrollMargin: number
  sizerRef: (node: HTMLDivElement | null) => void
  measureRow: (node: HTMLElement | null) => void
  /** Scroll so this element's top meets the top of the viewport. */
  alignToViewportTop: (element: HTMLElement) => void
}

/** Distance from a container's scroll origin down to a descendant, in the
 *  container's own scroll pixels. `offsetTop` rather than a rect because the transcript
 *  is zoomed: rects are viewport pixels, `scrollTop` is not. Absolutely
 *  positioned windowed rows are placed with `top`, never a transform, so this
 *  stays true through the window as well. */
export function nativeChatScrollOffsetWithin(element: HTMLElement, container: HTMLElement): number {
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
  if (node === container) {
    return top
  }
  // No chain to walk — a positioned ancestor outside the scroller, or a DOM with
  // no layout at all. Rects still describe the distance, in viewport pixels; the
  // container's own measured zoom converts them back into scroll pixels.
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
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const pinned = useMemo(
    () => nativeChatPinnedRowIndexes({ count: slots.length, revealIndex }),
    [slots.length, revealIndex]
  )
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  // Stable identities: the virtualizer keys its measurement memo on these, so a
  // fresh closure per render would rebuild every row's offset on every frame.
  const estimateSize = useCallback(
    (index: number) => slotsRef.current[index]?.estimatedHeight ?? FALLBACK_ROW_PX,
    []
  )
  const getItemKey = useCallback(
    (index: number) => slotsRef.current[index]?.message.id ?? index,
    []
  )
  const rangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) =>
      nativeChatTranscriptRange(range, pinnedRef.current),
    []
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
    const offset = nativeChatScrollOffsetWithin(sizer, container)
    setScrollMargin((current) => (current === offset ? current : offset))
  }, [scrollRef])
  useLayoutEffect(readScrollMargin)

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    const read = (): void => {
      const height = container.offsetHeight
      setViewportHeight((current) => (current === height ? current : height))
      readScrollMargin()
    }
    read()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(read)
    observer.observe(container)
    return () => observer.disconnect()
  }, [readScrollMargin, scrollRef])

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
      const top = nativeChatScrollOffsetWithin(element, container)
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

  // Unknown height means "not measured yet", not "unusable": falling back on the
  // first render would mount the entire transcript once before windowing ever
  // engaged, which is the cost this exists to avoid.
  const isWindowed =
    slots.length > 0 && (viewportHeight === null || viewportHeight >= MIN_WINDOWED_VIEWPORT_PX)

  return {
    isWindowed,
    virtualItems: isWindowed ? virtualizer.getVirtualItems() : [],
    totalSize: virtualizer.getTotalSize(),
    scrollMargin,
    sizerRef,
    measureRow: virtualizer.measureElement,
    alignToViewportTop
  }
}
