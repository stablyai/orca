// The rail's tick set: one entry per user message in the conversation.
//
// Loaded messages come from slots rather than messages because the rail's whole
// job is to point at a row, and a message that takes no slot has no row to point
// at. Slot indexes are also what the virtualizer counts, so an entry can be
// compared against a virtual item without a second lookup table. Messages older
// than the loaded window come from the host's outline and have no slot yet.

import {
  nativeChatTurnReplyPreviews,
  nativeChatUserMessagePreview
} from '../../../../shared/agent-session-conversation-outline'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Ticks up to this count sit at the roomy pitch; past it they pack tight. */
export const NATIVE_CHAT_RAIL_ROOMY_TICKS = 20
/** The tight pitch as the rail draws it: a 3px tick inside `py-0.5`. */
const RAIL_TIGHT_PITCH_PX = 7
const RAIL_VIEWPORT_SHARE = 0.7

/** How many ticks the rail may draw. A tick is the only way to its message, so
 *  the rail packs as many as a share of the viewport holds before sampling any
 *  away: a rail taller than that cannot be read at a glance. */
export function nativeChatRailTickCapacity(viewportHeight: number): number {
  return Math.max(
    NATIVE_CHAT_RAIL_ROOMY_TICKS,
    Math.floor((viewportHeight * RAIL_VIEWPORT_SHARE) / RAIL_TIGHT_PITCH_PX)
  )
}

export type NativeChatRailItem = {
  id: string
  /** Index into the slot list, i.e. the virtualizer's own index. Null while the
   *  message is known only from the outline: older history that is not loaded. */
  slotIndex: number | null
  /** Preview prose, whitespace collapsed. Empty when the message is images only. */
  text: string
  hasImages: boolean
  /** The host's preview of the agent's reply, on an outline item only. */
  reply?: string
  /** On an outline item that did not open its turn: the message that did. */
  turnKey?: string
}

/** A user message older than the loaded window, oldest first. */
export type NativeChatRailOutlineEntry = {
  id: string
  text: string
  hasImages: boolean
  reply?: string
  turnKey?: string
}

/** The transcript's rows and each one's turn, as the slots are built from them:
 *  before folding, so a folded turn still has its reply to read. */
export type NativeChatRailTurnRows = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
}

/** What the agent answered a rail item's turn with, read when its preview opens:
 *  carried on every item, a streaming reply would rebuild the rail on each frame.
 *  Loaded rows are authoritative for the turns they hold, including the tail of a
 *  turn whose prompt is no longer loaded; the host's reply covers the rest. */
export function nativeChatRailReplyPreview(
  { messages, turnKeys }: NativeChatRailTurnRows,
  items: readonly NativeChatRailItem[],
  id: string
): string {
  const row = messages.findIndex((message) => message.id === id)
  const item = items.find((candidate) => candidate.id === id)
  // An unloaded prompt is its turn's key unless the host names another: a steer's
  // turn is the one it was sent into.
  const turnKey = row === -1 ? (item?.turnKey ?? id) : turnKeys[row]
  const loaded =
    turnKey === undefined
      ? undefined
      : nativeChatTurnReplyPreviews(messages, turnKeys, turnKey).get(turnKey)
  return loaded ?? item?.reply ?? ''
}

export function buildNativeChatRailItems(
  slots: readonly NativeChatTranscriptSlot[],
  previous: readonly NativeChatRailItem[] = []
): readonly NativeChatRailItem[] {
  const items: NativeChatRailItem[] = []
  for (const [slotIndex, slot] of slots.entries()) {
    // A send a Stop took back is no tick, as the host's outline of older history leaves it
    // out. Nor is a subagent's prompt, drawn while its section is open: the rail maps
    // the conversation, and must not change with what the reader has expanded.
    if (
      slot.kind !== 'message' ||
      slot.depth !== 0 ||
      slot.message.role !== 'user' ||
      slot.message.stoppedBeforeStart === true
    ) {
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
 *  the kept ones: the tick the reader is on, and any they are previewing or have
 *  focused. Keeping the ends fixed is what makes the rail read as a map of the
 *  conversation rather than a window onto part of it. */
export function selectNativeChatRailTicks({
  items,
  keepIds = [],
  maxTicks = NATIVE_CHAT_RAIL_ROOMY_TICKS
}: {
  items: readonly NativeChatRailItem[]
  keepIds?: readonly (string | null)[]
  maxTicks?: number
}): readonly NativeChatRailItem[] {
  if (items.length <= maxTicks) {
    return items
  }

  const maxIndex = items.length - 1
  const sampled = new Set<number>()
  for (let slot = 0; slot < maxTicks; slot += 1) {
    sampled.add(Math.round((slot * maxIndex) / (maxTicks - 1)))
  }

  const kept = new Set<number>([0, maxIndex])
  for (const id of keepIds) {
    const index = id === null ? -1 : items.findIndex((item) => item.id === id)
    if (index >= 0) {
      kept.add(index)
    }
  }
  for (const keep of kept) {
    if (sampled.has(keep)) {
      continue
    }
    sampled.add(keep)
    // Drop the nearest neighbour that is not itself kept, never an end: losing one
    // would make the rail claim the thread starts or stops somewhere it doesn't.
    let evict: number | null = null
    let evictDistance = Number.POSITIVE_INFINITY
    for (const index of sampled) {
      const distance = Math.abs(index - keep)
      if (!kept.has(index) && distance < evictDistance) {
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
