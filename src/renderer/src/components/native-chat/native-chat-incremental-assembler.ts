// Incremental native-chat assembler. The full `assembleNativeChatSession` does
// an O(n log n) Map-build + sort on every call; on the hot streaming path the
// agent emits many small append batches over a growing transcript, so the full
// rebuild is quadratic per turn (#17). This splits the two mutation axes:
//
//   - base axis (session swap / loadEarlier re-read): rare, user-driven → reset,
//     a full rebuild that is byte-for-byte identical to assembleNativeChatSession.
//   - append axis (live streaming): hot → applyAppends, which feeds only the new
//     batch through the SAME mergeOne rule and splices at the tail when the batch
//     is purely-new and already-sorted, falling back to a full re-sort otherwise.
//
// Correctness invariant: applyAppends output deep-equals a full rebuild over
// base ++ all-appends for every prefix (locked by the oracle differential test).

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatMessageSortRank, orderNativeChatMessages } from './native-chat-message-order'
import { mergeOne } from './native-chat-session-assembler'

export type IncrementalChatAssembler = {
  byId: Map<string, NativeChatMessage>
  byTurn: Map<string, NativeChatMessage>
  // Last emitted sorted output; stable reference until a mutation occurs.
  messages: NativeChatMessage[]
}

export function createIncrementalAssembler(): IncrementalChatAssembler {
  return { byId: new Map(), byTurn: new Map(), messages: [] }
}

/** Rebuild the assembled state from a base list (the windowed read). Canonical
 *  path — equivalent to assembleNativeChatSession over `{ transcript: base }`. */
export function reset(
  assembler: IncrementalChatAssembler,
  base: readonly NativeChatMessage[]
): NativeChatMessage[] {
  assembler.byId = new Map()
  assembler.byTurn = new Map()
  for (const message of base) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }
  assembler.messages = orderNativeChatMessages(Array.from(assembler.byId.values()))
  return assembler.messages
}

/** Fold a live append batch through the same merge rule as the full rebuild.
 *  Fast path: when every incoming message is a brand-new id, has a brand-new
 *  turnKey-free identity (no merge/removal), and sorts at/after the current
 *  transcript tail, splice the batch in (O(k)). Any ambiguity → full re-sort of the
 *  whole map (still correct, just O(n log n) for that one rare batch). */
export function applyAppends(
  assembler: IncrementalChatAssembler,
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return assembler.messages
  }

  const sizeBefore = assembler.byId.size
  for (const message of incoming) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }

  // A merge or removal happened if the map didn't grow by exactly the batch
  // size — some incoming id/turn collided with or superseded an existing entry,
  // which can change an existing entry's sort position. Fall back to re-sort.
  const grewByBatch = assembler.byId.size === sizeBefore + incoming.length
  if (grewByBatch && isTranscriptTailAppend(assembler.messages, incoming)) {
    const deferredAt = assembler.messages.findIndex((message) => nativeChatMessageSortRank(message))
    const insertAt = deferredAt === -1 ? assembler.messages.length : deferredAt
    assembler.messages = [
      ...assembler.messages.slice(0, insertAt),
      ...incoming,
      ...assembler.messages.slice(insertAt)
    ]
    return assembler.messages
  }

  assembler.messages = orderNativeChatMessages(Array.from(assembler.byId.values()))
  return assembler.messages
}

/** True when file-order semantics put the whole batch after current transcript content. */
function isTranscriptTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  if (
    !current.every(
      (message) =>
        nativeChatMessageSortRank(message) > 0 ||
        (message.source === 'transcript' && nativeChatMessageSortRank(message) === 0)
    )
  ) {
    return false
  }
  let latestTime = current.reduce(
    (latest, message) => Math.max(latest, message.timestamp ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY
  )
  for (const message of incoming) {
    if (message.source !== 'transcript' || nativeChatMessageSortRank(message) !== 0) {
      return false
    }
    const timestamp = message.timestamp ?? Number.NEGATIVE_INFINITY
    if (!message.queued && timestamp < latestTime) {
      return false
    }
    latestTime = Math.max(latestTime, timestamp)
  }
  return true
}
