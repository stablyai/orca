// The rail's tick set: one entry per user message in the conversation.
//
// Loaded messages come from slots rather than messages because the rail's whole
// job is to point at a row, and a message that takes no slot has no row to point
// at. Slot indexes are also what the virtualizer counts, so an entry can be
// compared against a virtual item without a second lookup table. Messages older
// than the loaded window come from the host's outline and have no slot yet.

import { nativeChatUserMessagePreview } from '../../../../shared/agent-session-conversation-outline'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Ticks past this are sampled away: a taller rail than the viewport cannot be
 *  read at a glance, which is the only thing the rail is for. */
export const NATIVE_CHAT_RAIL_MAX_TICKS = 20

/** Below this a rail is noise — two ticks say nothing a scrollbar doesn't. */
export const NATIVE_CHAT_RAIL_MIN_ITEMS = 3

export type NativeChatRailItem = {
  id: string
  /** Index into the slot list, i.e. the virtualizer's own index. Null while the
   *  message is known only from the outline: older history that is not loaded. */
  slotIndex: number | null
  /** Preview prose, whitespace collapsed. Empty when the message is images only. */
  text: string
  hasImages: boolean
}

/** A user message older than the loaded window, oldest first. */
export type NativeChatRailOutlineEntry = {
  id: string
  text: string
  hasImages: boolean
}

export function buildNativeChatRailItems(
  slots: readonly NativeChatTranscriptSlot[],
  previous: readonly NativeChatRailItem[] = []
): readonly NativeChatRailItem[] {
  const items: NativeChatRailItem[] = []
  for (const [slotIndex, slot] of slots.entries()) {
    if (slot.message.role !== 'user') {
      continue
    }
    const preview = nativeChatUserMessagePreview(slot.message.blocks)
    const hasImages = preview.imageCount > 0
    const prior = previous[items.length]
    items.push(
      prior?.id === slot.message.id &&
        prior.slotIndex === slotIndex &&
        prior.text === preview.text &&
        prior.hasImages === hasImages
        ? prior
        : { id: slot.message.id, slotIndex, text: preview.text, hasImages }
    )
  }
  return items.length === previous.length && items.every((item, index) => item === previous[index])
    ? previous
    : items
}

/** Outline entries first, then the loaded items, so the rail maps the whole thread.
 *  A loaded item replaces its outline entry: it carries the slot a jump needs. */
export function mergeNativeChatRailOutline(
  outline: readonly NativeChatRailOutlineEntry[] | null,
  loaded: readonly NativeChatRailItem[]
): readonly NativeChatRailItem[] {
  if (!outline || outline.length === 0) {
    return loaded
  }
  const loadedIds = new Set(loaded.map((item) => item.id))
  const unloaded: NativeChatRailItem[] = []
  for (const entry of outline) {
    if (!loadedIds.has(entry.id)) {
      unloaded.push({ ...entry, slotIndex: null })
    }
  }
  return unloaded.length === 0 ? loaded : [...unloaded, ...loaded]
}

/** Evenly spaced ticks across the whole thread, always including both ends and
 *  the active one. Keeping the ends fixed is what makes the rail read as a map
 *  of the conversation rather than a window onto part of it. */
export function selectNativeChatRailTicks({
  items,
  activeId
}: {
  items: readonly NativeChatRailItem[]
  activeId: string | null
}): readonly NativeChatRailItem[] {
  if (items.length <= NATIVE_CHAT_RAIL_MAX_TICKS) {
    return items
  }

  const maxIndex = items.length - 1
  const sampled = new Set<number>()
  for (let slot = 0; slot < NATIVE_CHAT_RAIL_MAX_TICKS; slot += 1) {
    sampled.add(Math.round((slot * maxIndex) / (NATIVE_CHAT_RAIL_MAX_TICKS - 1)))
  }

  const activeIndex = activeId === null ? -1 : items.findIndex((item) => item.id === activeId)
  if (activeIndex >= 0 && !sampled.has(activeIndex)) {
    sampled.add(activeIndex)
    // Drop the neighbour nearest the active tick, never an end: losing an end
    // would make the rail claim the thread starts or stops somewhere it doesn't.
    let evict: number | null = null
    let evictDistance = Number.POSITIVE_INFINITY
    for (const index of sampled) {
      if (index === activeIndex || index === 0 || index === maxIndex) {
        continue
      }
      const distance = Math.abs(index - activeIndex)
      if (distance < evictDistance) {
        evict = index
        evictDistance = distance
      }
    }
    if (evict !== null) {
      sampled.delete(evict)
    }
  }

  const ordered: NativeChatRailItem[] = []
  for (const index of Array.from(sampled).sort((left, right) => left - right)) {
    const item = items[index]
    if (item) {
      ordered.push(item)
    }
  }
  return ordered
}
