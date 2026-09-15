// Which rail tick is lit, decided from virtualizer offsets rather than rendered rows.
//
// A DOM scan is the obvious way to answer "what is on screen", and it is the wrong
// one here: the transcript is windowed, so an off-window row has no element to
// measure. Virtual items carry the same answer without that hole.
//
// The row at the fold is usually the agent's, not the reader's — most of a long
// transcript is reply. Resolving it through `turnKey`, which every row carries and
// which holds the id of the user message that opened its turn, is what keeps the
// reader's own prompt lit while they read the answer to it. Asking instead which
// *user* row is on screen goes dark for the whole length of a long reply.
//
// Every offset below is in the scroll container's own pixels (rows are placed at
// `item.start - scrollMargin` inside a sizer sitting `scrollMargin` down), which is
// the same space as `scrollTop`. That keeps the comparison honest under the
// transcript's `zoom`, where a bounding rect would be off by exactly the zoom factor.

import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'

/** The virtualizer's item, restated so this module needs nothing from the lib. */
export type NativeChatRailVirtualItem = {
  index: number
  start: number
  end: number
}

/** Only the field the rail reads, so a test needs no slot builder. */
export type NativeChatRailSlot = {
  turnKey: string | undefined
}

export function findActiveNativeChatRailItem({
  slots,
  virtualItems,
  scrollTop,
  clientHeight,
  scrollHeight,
  previousActiveId
}: {
  slots: readonly NativeChatRailSlot[]
  virtualItems: readonly NativeChatRailVirtualItem[]
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  previousActiveId: string | null
}): string | null {
  if (virtualItems.length === 0) {
    return previousActiveId
  }

  // Pinned to the bottom the newest turn is what is being read, whatever happens
  // to sit at the top edge — a short last turn would otherwise light its predecessor.
  const atBottom = scrollHeight - clientHeight - scrollTop <= NATIVE_CHAT_BOTTOM_THRESHOLD_PX

  if (atBottom) {
    const last = virtualItems.at(-1)

    return last === undefined ? previousActiveId : (slots[last.index]?.turnKey ?? null)
  }

  let fold: NativeChatRailVirtualItem | undefined

  for (const item of virtualItems) {
    if (item.start <= scrollTop && (fold === undefined || item.start > fold.start)) {
      fold = item
    }
  }

  // Scrolled above everything the window holds: the first windowed row is the
  // nearest thing to the fold.
  if (fold === undefined) {
    return slots[virtualItems[0]?.index ?? -1]?.turnKey ?? null
  }

  // The window lags the scroll by a commit, so a fold past every row it holds is
  // a stale read, not an answer. Holding the previous tick beats blanking one.
  if (fold.end <= scrollTop) {
    return previousActiveId
  }

  return slots[fold.index]?.turnKey ?? null
}
