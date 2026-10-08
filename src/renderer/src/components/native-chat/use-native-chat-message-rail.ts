// Rail state: which user messages get a tick, and which tick is lit.
//
// The lit tick is recomputed once scrolling settles rather than per scroll event.
// Mid-scroll the answer is both expensive and useless — nobody reads a rail that
// is itself moving — and settling on it is what makes the highlight feel like a
// position report instead of a flicker.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findActiveNativeChatRailItem } from './native-chat-active-rail-item'
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

  const readActiveId = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    setActiveId((previous) =>
      findActiveNativeChatRailItem({
        slots: slotsRef.current,
        virtualItems: virtualItemsRef.current,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        previousActiveId: previous
      })
    )
  }, [scrollRef])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    let idleTimer: number | null = null
    const scheduleRead = (): void => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer)
      }
      idleTimer = window.setTimeout(() => {
        idleTimer = null
        readActiveId()
      }, NATIVE_CHAT_RAIL_IDLE_MS)
    }
    scheduleRead()
    element.addEventListener('scroll', scheduleRead, { passive: true })
    return () => {
      element.removeEventListener('scroll', scheduleRead)
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer)
      }
    }
    // Subscribed once. Depending on anything that changes per render would tear
    // the listener down and cancel the pending idle timer on every frame of a
    // streaming turn, so the highlight would never settle.
  }, [readActiveId, scrollRef])

  // Re-read when the set of prompts actually changes, so a transcript that grew
  // updates without waiting for the next scroll.
  useEffect(() => {
    readActiveId()
  }, [items, readActiveId])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      setWideEnough(element.clientWidth >= NATIVE_CHAT_RAIL_MIN_WIDTH_PX)
      setMaxTicks(nativeChatRailTickCapacity(element.clientHeight))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef])

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const ticks = useMemo(
    () => selectNativeChatRailTicks({ items, keepIds: [activeId, focusId, previewId], maxTicks }),
    [items, activeId, focusId, previewId, maxTicks]
  )
  const previewReply =
    previewId === null ? '' : nativeChatRailReplyPreview(turnRows, items, previewId)

  return useMemo(
    () => ({
      ticks,
      items,
      activeId,
      onActivate: setActiveId,
      visible: wideEnough && items.length > 0,
      previewId,
      previewReply,
      onPreview: setPreviewId,
      focusId,
      onFocusItem: setFocusId
    }),
    [ticks, items, activeId, wideEnough, previewId, previewReply, focusId]
  )
}
