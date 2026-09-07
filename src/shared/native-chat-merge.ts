// Pure id-dedup and windowing for both desktop and mobile native-chat streams.

import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage,
  type NativeChatSource
} from './native-chat-types'

export type NativeChatSourcePriority = Record<NativeChatSource, number>

/** Merge a batch of incoming messages into an existing ordered list, deduping by
 *  `id`. A re-emitted id replaces the existing entry in place only when the
 *  incoming source is at least as authoritative (higher-or-equal priority); new
 *  ids append in arrival order. First-seen order is preserved; never mutates the
 *  input; returns a new array (or the existing reference for an empty batch). */
export function mergeNativeChatMessagesWith(
  existing: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[],
  priority: NativeChatSourcePriority
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return existing as NativeChatMessage[]
  }
  const merged = [...existing]
  const indexById = new Map<string, number>()
  merged.forEach((message, index) => indexById.set(message.id, index))
  applyIncoming(merged, indexById, incoming, priority)
  return merged
}

export function mergeNativeChatMessages(
  existing: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return mergeNativeChatMessagesWith(existing, incoming, NATIVE_CHAT_SOURCE_PRIORITY)
}

/** Cap a message list to its most-recent `limit` entries. The base read is
 *  already windowed; this keeps the live-append tail bounded to the same window
 *  so a long run can't grow the list without limit. A non-positive limit means
 *  "no cap". Returns the input reference when no trim is needed. */
export function boundNativeChatWindow(
  messages: readonly NativeChatMessage[],
  limit: number
): NativeChatMessage[] {
  if (limit <= 0 || messages.length <= limit) {
    return messages as NativeChatMessage[]
  }
  return messages.slice(messages.length - limit)
}

/** Stateful id-dedup merger that caches the id→index map across appends so a
 *  streaming run pays O(incoming) per frame instead of O(existing+incoming).
 *  `replaceList` resets the cache for a new base (initial read / loadEarlier);
 *  `applyAppend` folds a live batch in. Output equals the pure
 *  `mergeNativeChatMessagesWith` for every input (locked by the oracle test). */
export type NativeChatMerger = {
  list: NativeChatMessage[]
  readonly indexById: Map<string, number>
  readonly priority: NativeChatSourcePriority
}

export function createNativeChatMerger(
  priority: NativeChatSourcePriority = NATIVE_CHAT_SOURCE_PRIORITY
): NativeChatMerger {
  return { list: [], indexById: new Map(), priority }
}

/** Reset the merger to a new base list (replace, don't merge). Used on the
 *  initial read and loadEarlier re-reads, which return an ordered tail. */
export function replaceList(merger: NativeChatMerger, list: readonly NativeChatMessage[]): void {
  merger.list = [...list]
  merger.indexById.clear()
  merger.list.forEach((message, index) => merger.indexById.set(message.id, index))
}

/** Fold a live batch into the merger, deduping by id with source precedence.
 *  Returns a new `list` reference (so React re-renders) and updates the cached
 *  index incrementally — O(incoming), never re-scanning the existing list. */
export function applyAppend(
  merger: NativeChatMerger,
  incoming: readonly NativeChatMessage[],
  limit?: number
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return merger.list
  }
  const next = [...merger.list]
  applyIncoming(next, merger.indexById, incoming, merger.priority)
  const bounded = limit === undefined ? next : boundNativeChatWindow(next, limit)
  if (bounded !== next) {
    // Why: trimming shifts every cached index, so rebuild at the window boundary.
    replaceList(merger, bounded)
    return merger.list
  }
  merger.list = next
  return next
}

// Shared inner loop: one id-dedup + precedence rule for both the pure function
// and the stateful merger, so the two can never drift.
function applyIncoming(
  list: NativeChatMessage[],
  indexById: Map<string, number>,
  incoming: readonly NativeChatMessage[],
  priority: NativeChatSourcePriority
): void {
  for (const message of incoming) {
    const at = indexById.get(message.id)
    if (at === undefined) {
      indexById.set(message.id, list.length)
      list.push(message)
      continue
    }
    const current = list[at]!
    if (priority[message.source] >= priority[current.source]) {
      list[at] = message
    }
  }
}
