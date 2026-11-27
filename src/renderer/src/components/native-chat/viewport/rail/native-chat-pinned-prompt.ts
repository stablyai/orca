// The prompt to pin above the transcript: the one whose turn owns the top edge, unless the reader
// is at the end, where the composer already shows it.

import type { NativeChatRailItem } from './native-chat-message-rail-items'

/**
 * `activeId` already names the prompt of the row at the top edge, from virtual offsets, so it holds
 * even when that row has been windowed out. Unloaded outline prompts are skipped: paging scrolls to
 * them, and the header would cover where they land.
 */
export function findNativeChatPinnedPrompt({
  activeId,
  items,
  readerAtEnd
}: {
  activeId: string | null
  items: readonly NativeChatRailItem[]
  readerAtEnd: boolean
}): NativeChatRailItem | null {
  if (readerAtEnd || activeId === null) {
    return null
  }
  const item = items.find((candidate) => candidate.id === activeId)
  return item === undefined || item.slotIndex === null ? null : item
}
