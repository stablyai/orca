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
  selectNativeChatRailTicks,
  NATIVE_CHAT_RAIL_MIN_ITEMS,
  type NativeChatRailItem
} from './native-chat-message-rail-items'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

/** Quiet period that counts as "stopped scrolling". */
export const NATIVE_CHAT_RAIL_IDLE_MS = 120

/** Narrower than this the panel would cover the message it previews, so the whole
 *  rail stands down rather than half-working in a split pane. */
export const NATIVE_CHAT_RAIL_MIN_WIDTH_PX = 512

export type NativeChatMessageRailState = {
  ticks: readonly NativeChatRailItem[]
  items: readonly NativeChatRailItem[]
  activeId: string | null
  visible: boolean
}

export function useNativeChatMessageRail({
  scrollRef,
  slots,
  virtualItems
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  virtualItems: NativeChatTranscriptWindow['virtualItems']
}): NativeChatMessageRailState {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [wideEnough, setWideEnough] = useState(true)

  const previousItemsRef = useRef<readonly NativeChatRailItem[]>([])
  const items = buildNativeChatRailItems(slots, previousItemsRef.current)
  previousItemsRef.current = items

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
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [scrollRef])

  const ticks = useMemo(() => selectNativeChatRailTicks({ items, activeId }), [items, activeId])

  return useMemo(
    () => ({
      ticks,
      items,
      activeId,
      visible: wideEnough && items.length >= NATIVE_CHAT_RAIL_MIN_ITEMS
    }),
    [ticks, items, activeId, wideEnough]
  )
}
