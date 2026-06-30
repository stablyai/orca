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
import { compareMessages, mergeOne } from './native-chat-session-assembler'

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
  assembler.messages = Array.from(assembler.byId.values()).sort(compareMessages)
  return assembler.messages
}

/** Fold a live append batch through the same merge rule as the full rebuild.
 *  Fast path: when every incoming message is a brand-new id, has a brand-new
 *  turnKey-free identity (no merge/removal), and sorts at/after the current
 *  tail, splice the batch in (O(k log k)). Any ambiguity → full re-sort of the
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
  if (grewByBatch && isTailAppend(assembler.messages, incoming)) {
    // Every incoming message is new and sorts at/after the tail: splice the
    // batch in its own sorted order without touching the existing prefix.
    const tail = [...incoming].sort(compareMessages)
    assembler.messages = [...assembler.messages, ...tail]
    return assembler.messages
  }

  assembler.messages = Array.from(assembler.byId.values()).sort(compareMessages)
  return assembler.messages
}

/** True when the whole batch sorts strictly at/after the current last message
 *  AND is internally unambiguous to splice. A null timestamp in the batch sorts
 *  before any real timestamp, so it can never be a pure tail append — bail to
 *  the full re-sort. */
function isTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  const last = current.at(-1)
  if (!last) {
    return true
  }
  for (const message of incoming) {
    // Null timestamp (sorts to the front) can never be a tail append.
    if (message.timestamp === null) {
      return false
    }
    if (compareMessages(message, last) < 0) {
      return false
    }
  }
  return true
}
