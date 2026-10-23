// Rail state: which user messages get a tick, and which tick is lit.
//
// The lit tick is recomputed once scrolling settles rather than per scroll event.
// Mid-scroll the answer is both expensive and useless — nobody reads a rail that
// is itself moving — and settling on it is what makes the highlight feel like a
// position report instead of a flicker.

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

/** Quiet period that counts as "stopped scrolling". */
export const NATIVE_CHAT_RAIL_IDLE_MS = 120

/** Narrower than this the preview card would cover the transcript it sits beside,
 *  so the whole rail stands down rather than half-working in a split pane. */
export const NATIVE_CHAT_RAIL_MIN_WIDTH_PX = 512

export type NativeChatMessageRailState = {
  ticks: readonly NativeChatRailItem[]
  items: readonly NativeChatRailItem[]
  activeId: string | null
  /** Light a tick now, ahead of the scroll that is taking the reader to it. */
  onActivate: (id: string) => void
  visible: boolean
  /** The item whose preview is open, if any. */
  previewId: string | null
  /** The item whose tick holds keyboard focus, if any. */
  focusId: string | null
  /** The rail names the item it focused, or is about to: an item named here
   *  always has a tick, so arrow keys can walk every message, sampled or not. */
  onFocusItem: (id: string | null) => void
  /** What the agent answered the previewed item with; empty when nothing is
   *  previewed or it has said nothing. Follows a reply that is still streaming. */
  previewReply: string
  /** The rail names the item its preview shows, or null once it closes. */
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

  // Read through refs so a settling scroll never re-subscribes the listener:
  // `virtualItems` is a fresh array on every frame of a scroll.
  const virtualItemsRef = useRef(virtualItems)
  virtualItemsRef.current = virtualItems
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  // A clicked tick stays lit while its row stays on screen where the jump settled it:
  // a jump clamped short of the top leaves another row at the fold, or the last at the
  // bottom. `offset` is the row's distance below the viewport top, once settled.
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
        // The committed items: a read only ever follows a commit.
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
    // Subscribed once. Depending on anything that changes per render would tear
    // the listener down and cancel the pending idle timer on every frame of a
    // streaming turn, so the highlight would never settle.
  }, [scheduleRead, scrollRef])

  // Re-read when the set of prompts actually changes, so a transcript that grew
  // updates without waiting for the next scroll. A click still landing is read once it settles.
  useEffect(() => {
    if (clickedRef.current?.offset !== null) {
      readActiveId()
    }
  }, [items, readActiveId])

  // Measured before first paint: the transcript's padding follows wideEnough, so a late read shifts the text.
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
  // A jump that does not move the view fires no scroll, so its landing is read from here.
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
