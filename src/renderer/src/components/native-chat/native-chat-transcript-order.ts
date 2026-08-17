import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Renderer-local ordering for live transcript rows within one source generation. */
export type NativeChatTranscriptOrder = {
  generation: number
  highWater: number
  messageSequenceById: ReadonlyMap<string, number>
}

export function createNativeChatTranscriptOrder(generation = 0): NativeChatTranscriptOrder {
  return { generation, highWater: 0, messageSequenceById: new Map() }
}

/** New generation after a source rebind; prior sequence memory is discarded. */
export function replaceNativeChatTranscriptOrder(
  previous: NativeChatTranscriptOrder
): NativeChatTranscriptOrder {
  return createNativeChatTranscriptOrder(previous.generation + 1)
}

/**
 * Authoritative snapshot/replacement settlement: first-seen ids in this generation
 * become post-action sequence rows so empty-boundary pending/clear can match them
 * without a live append frame. Already-sequenced ids keep stable numbers.
 */
export function settleNativeChatTranscriptOrder(
  previous: NativeChatTranscriptOrder,
  messages: readonly NativeChatMessage[],
  retainedCount: number
): NativeChatTranscriptOrder {
  let highWater = previous.highWater
  const nextById = new Map<string, number>()
  for (const message of messages) {
    const existing = previous.messageSequenceById.get(message.id)
    if (existing !== undefined) {
      nextById.set(message.id, existing)
      continue
    }
    highWater += 1
    nextById.set(message.id, highWater)
  }
  if (nextById.size > retainedCount) {
    const ranked = [...nextById.entries()].sort((left, right) => left[1] - right[1])
    const dropCount = nextById.size - retainedCount
    for (let index = 0; index < dropCount; index += 1) {
      const oldest = ranked[index]
      if (oldest) {
        nextById.delete(oldest[0])
      }
    }
  }
  return {
    generation: previous.generation,
    highWater,
    messageSequenceById: nextById
  }
}

export function appendNativeChatTranscriptOrder(
  previous: NativeChatTranscriptOrder,
  incoming: readonly NativeChatMessage[],
  retainedCount: number
): NativeChatTranscriptOrder {
  if (incoming.length === 0) {
    return previous
  }
  let highWater = previous.highWater
  // The map is hook-owned; mutating it avoids copying the whole transcript
  // window on every streaming frame while the wrapper identity still advances.
  const nextById = previous.messageSequenceById as Map<string, number>
  for (const message of incoming) {
    if (!nextById.has(message.id)) {
      highWater += 1
      nextById.set(message.id, highWater)
    }
  }
  while (nextById.size > retainedCount) {
    const oldestId = nextById.keys().next().value
    if (oldestId === undefined) {
      break
    }
    nextById.delete(oldestId)
  }
  return { generation: previous.generation, highWater, messageSequenceById: nextById }
}
