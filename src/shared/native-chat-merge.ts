// Pure id-dedup merge for native-chat message windows, shared by the desktop
// renderer live path. Mobile keeps a parity-locked twin of this algorithm
// (mobile/src/session/mobile-native-chat-merge.ts) because Metro can't resolve
// runtime values outside the mobile package — the cross-surface parity test
// (native-chat-merge-parity.test.ts) pins the two implementations together.
//
// The algorithm is parameterized on a source-priority map so the single body
// works for any caller that supplies NATIVE_CHAT_SOURCE_PRIORITY.

import type { NativeChatMessage, NativeChatSource } from './native-chat-types'

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

export function createNativeChatMerger(priority: NativeChatSourcePriority): NativeChatMerger {
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
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return merger.list
  }
  const next = [...merger.list]
  applyIncoming(next, merger.indexById, incoming, merger.priority)
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
