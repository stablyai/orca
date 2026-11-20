// Share full-rebuild merge rules; append new sorted tails cheaply, reset on base changes, and preserve full-rebuild equality at every prefix.

import {
  hasImagePromptMarker,
  isImageSourceUserTurn
} from '../../../../../../../shared/native-chat/transcript/images/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { compareNativeChatDisplayMessages as compareMessages } from '../../../../../../../shared/native-chat/transcript/messages/native-chat-message-order'
import { mergeOne, sortForImageNormalization, turnKey } from './native-chat-session-assembler'

export type IncrementalChatAssembler = {
  byId: Map<string, NativeChatMessage>
  byTurn: Map<string, NativeChatMessage>
  // Last emitted sorted output; stable reference until a mutation occurs.
  messages: NativeChatMessage[]
}

export function createIncrementalAssembler(): IncrementalChatAssembler {
  return { byId: new Map(), byTurn: new Map(), messages: [] }
}

/** Reset from a windowed base using the canonical transcript-only assembly path. */
export function reset(
  assembler: IncrementalChatAssembler,
  base: readonly NativeChatMessage[]
): NativeChatMessage[] {
  assembler.byId = new Map()
  assembler.byTurn = new Map()
  for (const message of base) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }
  assembler.messages = [...sortForImageNormalization(Array.from(assembler.byId.values()))]
  return assembler.messages
}

/** A copy rewound to what a reset over `applied.slice(0, keep)` builds, or null when the dropped
 *  rows could have changed how kept rows merged, grouped or sorted. Never mutates `committed`. */
export function rewind(
  committed: IncrementalChatAssembler,
  applied: readonly NativeChatMessage[],
  keep: number
): IncrementalChatAssembler | null {
  const dropped = new Set(applied.slice(keep))
  const kept = new Set<NativeChatMessage>()
  // A live tail repeats rows already held; re-merging the same object is a no-op, any other merge is not.
  for (
    let index = 0;
    committed.byId.size !== applied.length && index < applied.length;
    index += 1
  ) {
    const message = applied[index]!
    if (committed.byId.get(message.id) !== message) {
      return null
    }
    if (index < keep && dropped.has(message)) {
      kept.add(message)
    }
  }
  const removed = Array.from(dropped).filter((message) => !kept.has(message))
  const at = committed.messages.length - removed.length
  if (at < 0) {
    return null
  }
  const last = committed.messages[at - 1]
  if (last && isImageRow(last)) {
    return null
  }
  const removing = new Set(removed)
  for (let index = at; index < committed.messages.length; index += 1) {
    const message = committed.messages[index]!
    // Removed rows must be the sorted tail, after the kept rows and outside any image unit.
    if (
      !removing.has(message) ||
      isImageRow(message) ||
      (last !== undefined && compareMessages(message, last) <= 0)
    ) {
      return null
    }
  }
  // A kept window without source positions is not resorted, so it would not keep this order.
  if (
    removed.some((message) => message.transcriptOrder !== undefined) &&
    !hasSourcePosition(applied, keep)
  ) {
    return null
  }
  const assembler: IncrementalChatAssembler = {
    byId: new Map(committed.byId),
    byTurn: new Map(committed.byTurn),
    messages: committed.messages.slice(0, at)
  }
  const lostKeys = new Set<string>()
  for (const message of removed) {
    assembler.byId.delete(message.id)
    const key = turnKey(message)
    if (assembler.byTurn.get(key) === message) {
      assembler.byTurn.delete(key)
      lostKeys.add(key)
    }
  }
  // Without merges, same-key rows share a source and the latest one represents the key.
  for (let index = keep - 1; index >= 0 && lostKeys.size > 0; index -= 1) {
    const key = turnKey(applied[index]!)
    if (lostKeys.delete(key)) {
      assembler.byTurn.set(key, applied[index]!)
    }
  }
  return assembler
}

function hasSourcePosition(messages: readonly NativeChatMessage[], to: number): boolean {
  for (let index = 0; index < to; index += 1) {
    if (messages[index]!.transcriptOrder !== undefined) {
      return true
    }
  }
  return false
}

function isImageRow(message: NativeChatMessage): boolean {
  return isImageSourceUserTurn(message) || hasImagePromptMarker(message)
}

/** Merge through canonical rules; sort only a wholly new tail batch, otherwise resort the full map. */
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

  // Map growth below batch size means collisions/removals may have moved existing sort positions.
  const grewByBatch = assembler.byId.size === sizeBefore + incoming.length
  if (grewByBatch && isTailAppend(assembler.messages, incoming)) {
    // Sort only the new tail and preserve existing row identities.
    const tail = [...sortForImageNormalization(incoming)]
    assembler.messages = [...assembler.messages, ...tail]
    return assembler.messages
  }

  assembler.messages = [...sortForImageNormalization(Array.from(assembler.byId.values()))]
  return assembler.messages
}

/** Compare canonical appends by source position, including null and backward provider clocks. */
function isTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  const last = current.at(-1)
  if (!last) {
    return true
  }
  if (
    incoming[0]?.source === last.source &&
    ((hasImagePromptMarker(last) &&
      incoming[0]?.timestamp === last.timestamp &&
      isImageSourceUserTurn(incoming[0]!)) ||
      (isImageSourceUserTurn(last) && hasImagePromptMarker(incoming[0]!)))
  ) {
    return false
  }
  // Image units sort by their prompt, so a companion can outrank the row after it; retain the source high-water mark.
  const previous = current.at(-2)
  const boundary = previous && compareMessages(previous, last) > 0 ? previous : last
  for (const message of incoming) {
    // Supplemental insertion depends on the canonical sequence, not its last clock.
    if (boundary.transcriptOrder !== undefined && message.source !== 'transcript') {
      return false
    }
    if (message.timestamp === null && message.transcriptOrder === undefined) {
      return false
    }
    if (compareMessages(message, boundary) < 0) {
      return false
    }
  }
  return true
}
