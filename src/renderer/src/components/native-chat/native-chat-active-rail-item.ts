// Resolve ticks from virtual offsets because windowed rows may have no DOM; all offsets share scrollTop’s coordinate space.

import { NATIVE_CHAT_FOLLOW_REARM_PX } from './native-chat-autoscroll'
import type { NativeChatRailItem } from './native-chat-message-rail-items'

type NativeChatRailTick = Pick<NativeChatRailItem, 'id' | 'slotIndex'>

export type NativeChatRailVirtualItem = {
  index: number
  start: number
  end: number
}

export type NativeChatRailSlot = {
  turnKey: string | undefined
}

function railTickOf(
  slots: readonly NativeChatRailSlot[],
  ticks: readonly NativeChatRailTick[],
  index: number
): string | null {
  return (
    ticks.findLast((tick) => tick.slotIndex !== null && tick.slotIndex <= index)?.id ??
    slots[index]?.turnKey ??
    null
  )
}

export function findActiveNativeChatRailItem({
  slots,
  ticks,
  virtualItems,
  scrollTop,
  clientHeight,
  scrollHeight,
  previousActiveId
}: {
  slots: readonly NativeChatRailSlot[]
  /** The loaded rail items, in slot order. */
  ticks: readonly NativeChatRailTick[]
  virtualItems: readonly NativeChatRailVirtualItem[]
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  previousActiveId: string | null
}): string | null {
  if (virtualItems.length === 0) {
    return previousActiveId
  }

  // Use the narrow follow band for newest-turn highlighting; near-end jumps must still light their own prompt.
  const atBottom = scrollHeight - clientHeight - scrollTop <= NATIVE_CHAT_FOLLOW_REARM_PX
  if (atBottom) {
    const last = virtualItems.at(-1)
    return last === undefined ? previousActiveId : railTickOf(slots, ticks, last.index)
  }

  let fold: NativeChatRailVirtualItem | undefined
  for (const item of virtualItems) {
    if (item.start <= scrollTop && (fold === undefined || item.start > fold.start)) {
      fold = item
    }
  }
  // Above all mounted rows, use the first virtual row as the nearest fold.
  if (fold === undefined) {
    return railTickOf(slots, ticks, virtualItems[0]?.index ?? -1)
  }
  // A fold beyond the virtual window is stale; retain the previous tick until commit catches up.
  if (fold.end <= scrollTop) {
    return previousActiveId
  }
  return railTickOf(slots, ticks, fold.index)
}
