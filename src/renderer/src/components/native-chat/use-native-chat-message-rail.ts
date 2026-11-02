// Compute the active tick after scrolling settles to avoid expensive, flickering position reports mid-scroll.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { findActiveNativeChatRailItem } from './native-chat-active-rail-item'
import { ALIGN_ARRIVED_PX } from './use-native-chat-viewport-align'
import {
  buildNativeChatRailItems,
  mergeNativeChatRailOutline,
  NATIVE_CHAT_RAIL_ROOMY_TICKS,
  nativeChatRailReplyPreview,
  nativeChatRailTickCapacity,
  selectNativeChatRailTicks,
  type NativeChatRailItem,
  type NativeChatRailOutlineEntry,
  type NativeChatRailTurnRows
} from './native-chat-message-rail-items'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

export const NATIVE_CHAT_RAIL_IDLE_MS = 120

/** Hide the rail in narrow panes where its preview would cover the transcript. */
export const NATIVE_CHAT_RAIL_MIN_WIDTH_PX = 512

export type NativeChatMessageRailState = {
  ticks: readonly NativeChatRailItem[]
  items: readonly NativeChatRailItem[]
  activeId: string | null
  /** Light a tick now, ahead of the scroll that is taking the reader to it. */
  onActivate: (id: string) => void
  visible: boolean
  previewId: string | null
  focusId: string | null
  /** Keep the focused item’s tick mounted so arrow keys can reach unsampled messages. */
  onFocusItem: (id: string | null) => void
  /** Reply to the previewed turn, including streaming text; empty without a reply. */
  previewReply: string
  onPreview: (id: string | null) => void
}

export function useNativeChatMessageRail({
  scrollRef,
  slots,
  turnRows,
  virtualItems,
  outline = null
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  /** The rows the slots were built from, for the previewed turn's reply. */
  turnRows: NativeChatRailTurnRows
  virtualItems: NativeChatTranscriptWindow['virtualItems']
  /** User messages older than the loaded window; null when none are known. */
  outline?: readonly NativeChatRailOutlineEntry[] | null
}): NativeChatMessageRailState {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [wideEnough, setWideEnough] = useState(true)
  const [maxTicks, setMaxTicks] = useState(NATIVE_CHAT_RAIL_ROOMY_TICKS)

  const previousItemsRef = useRef<readonly NativeChatRailItem[]>([])
  const loadedItems = buildNativeChatRailItems(slots, previousItemsRef.current)
  // Written after commit so a discarded render cannot become the next one's baseline.
  useEffect(() => {
    previousItemsRef.current = loadedItems
  }, [loadedItems])
  const items = useMemo(
    () => mergeNativeChatRailOutline(outline, loadedItems),
    [outline, loadedItems]
  )

  // Read fresh per-frame arrays through refs so scroll listeners and idle timers stay subscribed.
  const virtualItemsRef = useRef(virtualItems)
  virtualItemsRef.current = virtualItems
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  // Keep a clicked tick lit at its settled row offset; clamped jumps cannot place the row at the fold.
  const clickedRef = useRef<{ id: string; offset: number | null } | null>(null)

  const readActiveId = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const clicked = clickedRef.current
    if (clicked !== null) {
      const top = element.scrollTop
      const slotIndex = previousItemsRef.current.find((item) => item.id === clicked.id)?.slotIndex
      const row = virtualItemsRef.current.find((item) => item.index === slotIndex)
      if (row && row.end > top && row.start < top + element.clientHeight) {
        clicked.offset ??= row.start - top
        if (Math.abs(row.start - top - clicked.offset) <= ALIGN_ARRIVED_PX) {
          return
        }
      }
      clickedRef.current = null
    }
    setActiveId((previous) =>
      findActiveNativeChatRailItem({
        slots: slotsRef.current,
        ticks: previousItemsRef.current,
        virtualItems: virtualItemsRef.current,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        previousActiveId: previous
      })
    )
  }, [scrollRef])

  const idleTimerRef = useRef<number | null>(null)
  const scheduleRead = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null
      readActiveId()
    }, NATIVE_CHAT_RAIL_IDLE_MS)
  }, [readActiveId])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    scheduleRead()
    element.addEventListener('scroll', scheduleRead, { passive: true })
    return () => {
      element.removeEventListener('scroll', scheduleRead)
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
    // Per-render dependencies would cancel idle timers on streaming frames and prevent settlement.
  }, [scheduleRead, scrollRef])

  // Prompt changes need a read without waiting for scroll; in-flight jumps wait until settled.
  useEffect(() => {
    if (clickedRef.current?.offset !== null) {
      readActiveId()
    }
  }, [items, readActiveId])

  // Measure before paint because rail-dependent padding would otherwise shift transcript text.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = (): void => {
      setWideEnough(element.clientWidth >= NATIVE_CHAT_RAIL_MIN_WIDTH_PX)
      setMaxTicks(nativeChatRailTickCapacity(element.clientHeight))
    }
    measure()
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef])

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const ticks = useMemo(
    () => selectNativeChatRailTicks({ items, keepIds: [activeId, focusId, previewId], maxTicks }),
    [items, activeId, focusId, previewId, maxTicks]
  )
  // Jumps that do not move the view fire no scroll event; schedule their landing read here.
  const onActivate = useCallback(
    (id: string) => {
      clickedRef.current = { id, offset: null }
      setActiveId(id)
      scheduleRead()
    },
    [scheduleRead]
  )
  const previewReply =
    previewId === null ? '' : nativeChatRailReplyPreview(turnRows, items, previewId)

  return useMemo(
    () => ({
      ticks,
      items,
      activeId,
      onActivate,
      visible: wideEnough && items.length > 0,
      previewId,
      previewReply,
      onPreview: setPreviewId,
      focusId,
      onFocusItem: setFocusId
    }),
    [ticks, items, activeId, onActivate, wideEnough, previewId, previewReply, focusId]
  )
}
