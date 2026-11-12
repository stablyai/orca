import {
  nativeChatMessagesShareTranscriptRow,
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage,
  type NativeChatSource
} from './native-chat-types'

export type NativeChatSourcePriority = Record<NativeChatSource, number>

/** Deduplicate by id: replace in place only from equal/higher authority; append new ids in arrival order.
 * Preserve first-seen order without mutating input; empty batches retain the existing reference. */
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

/** Keep the recent tail without splitting a provider row. A non-positive limit means no cap. */
export function boundNativeChatWindow(
  messages: readonly NativeChatMessage[],
  limit: number
): NativeChatMessage[] {
  if (limit <= 0 || messages.length <= limit) {
    return messages as NativeChatMessage[]
  }
  let start = messages.length - limit
  while (start > 0 && nativeChatMessagesShareTranscriptRow(messages[start - 1], messages[start])) {
    start -= 1
  }
  return messages.slice(start)
}

/** Cached id→index merger costs O(incoming) per frame. replaceList resets initial/loadEarlier bases; applyAppend streams batches.
 * Must equal mergeNativeChatMessagesWith for every input, checked by the differential oracle. */
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

/** Reset the base/cache on initial reads and ordered loadEarlier tails. */
export function replaceList(merger: NativeChatMerger, list: readonly NativeChatMessage[]): void {
  merger.list = [...list]
  merger.indexById.clear()
  merger.list.forEach((message, index) => merger.indexById.set(message.id, index))
}

/** Merge with source precedence in O(incoming); replace the list reference for React while incrementally updating indexes. */
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

// Share deduplication/source precedence between pure and cached mergers.
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
