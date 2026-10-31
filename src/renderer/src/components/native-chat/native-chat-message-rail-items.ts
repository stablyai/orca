// Index loaded prompts by virtualizer slots; older outline prompts have no slot until paging loads them.

import {
  nativeChatTurnReplyPreviews,
  nativeChatUserMessagePreview
} from '../../../../shared/agent-session/agent-session-conversation-outline'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Ticks up to this count sit at the roomy pitch; past it they pack tight. */
export const NATIVE_CHAT_RAIL_ROOMY_TICKS = 20
/** The tight pitch as the rail draws it: a 3px tick inside `py-0.5`. */
const RAIL_TIGHT_PITCH_PX = 7
const RAIL_VIEWPORT_SHARE = 0.7

/** Fit ticks within the viewport share before sampling; never shrink below roomy capacity. */
export function nativeChatRailTickCapacity(viewportHeight: number): number {
  return Math.max(
    NATIVE_CHAT_RAIL_ROOMY_TICKS,
    Math.floor((viewportHeight * RAIL_VIEWPORT_SHARE) / RAIL_TIGHT_PITCH_PX)
  )
}

export type NativeChatRailItem = {
  id: string
  /** Virtualizer slot index, or null for unloaded outline-only history. */
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

/** Read turn rows before folding so hidden activity still supplies reply previews. */
export type NativeChatRailTurnRows = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
}

/** Resolve replies only on preview to avoid rebuilding ticks on every stream frame; loaded turn tails outrank host previews. */
export function nativeChatRailReplyPreview(
  { messages, turnKeys }: NativeChatRailTurnRows,
  items: readonly NativeChatRailItem[],
  id: string
): string {
  const row = messages.findIndex((message) => message.id === id)
  const item = items.find((candidate) => candidate.id === id)
  // Unloaded prompts default to their own turn; steers use the host’s opener key.
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
    // Exclude withdrawn sends and subagent prompts so rail contents do not depend on section expansion.
    if (
      slot.kind !== 'message' ||
      slot.depth !== 0 ||
      slot.message.role !== 'user' ||
      slot.message.from !== undefined ||
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

/** Merge outline then loaded items, replacing outline copies with jump-capable slot identities. */
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

/** Sample evenly while keeping both ends, the active tick and every focused/previewed tick. */
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
    // Evict only unkept interior neighbors so sampling cannot imply a false thread start/end.
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
