// Share full-rebuild merge rules; append new sorted tails cheaply, reset on base changes, and preserve full-rebuild equality at every prefix.

import {
  hasImagePromptMarker,
  isImageSourceUserTurn
} from '../../../../shared/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  compareMessages,
  mergeOne,
  sortForImageNormalization
} from './native-chat-session-assembler'

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

/** Require every message at/after the tail; null timestamps force a full sort because they belong first. */
function isTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  const last = current.at(-1)
  if (!last) {
    return true
  }
  if (
    hasImagePromptMarker(last) &&
    incoming[0]?.source === last.source &&
    incoming[0]?.timestamp === last.timestamp &&
    isImageSourceUserTurn(incoming[0]!)
  ) {
    return false
  }
  for (const message of incoming) {
    if (message.timestamp === null) {
      return false
    }
    if (compareMessages(message, last) < 0) {
      return false
    }
  }
  return true
}
