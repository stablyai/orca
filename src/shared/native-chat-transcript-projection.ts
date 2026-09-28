// The transcript's projection of a conversation's messages into the rows it draws:
// ordered, tool runs folded into the turn that made them, harness turns dropped.
// Shared so the host's conversation outline asks "which user messages draw a row?"
// of exactly what the renderer's transcript runs, not a second reading of it.

import type { NativeChatMessage } from './native-chat-types'
import { isDeliveryNoiseMessage, isNoiseMessage } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'

export type NativeChatTranscriptProjection = {
  messages: NativeChatMessage[]
  /** Rows that follow a dropped delivery (cross-session message, task
   *  notification, …): each opens a new reply inside its turn. */
  replyStartIds: ReadonlySet<string>
}

/** Timestamp, then id. A null timestamp sorts first so a source that cannot supply
 *  one stays in place rather than jumping to the end. */
export function compareNativeChatMessagesByTime(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  const at = a.timestamp ?? Number.NEGATIVE_INFINITY
  const bt = b.timestamp ?? Number.NEGATIVE_INFINITY
  if (at !== bt) {
    return at - bt
  }
  if (a.id < b.id) {
    return -1
  }
  if (a.id > b.id) {
    return 1
  }
  return 0
}

/** `compare` lets the renderer order its own tail rows (streaming, optimistic
 *  sends), which never exist on the host. */
export function projectNativeChatTranscript(
  messages: readonly NativeChatMessage[],
  compare: (a: NativeChatMessage, b: NativeChatMessage) => number = compareNativeChatMessagesByTime
): NativeChatTranscriptProjection {
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  const folded = foldToolMessages(Array.from(messages).sort(compare))
  const projected: NativeChatMessage[] = []
  const replyStartIds = new Set<string>()
  let afterDelivery = false
  for (const message of folded) {
    if (isNoiseMessage(message)) {
      afterDelivery ||= isDeliveryNoiseMessage(message)
      continue
    }
    if (afterDelivery) {
      replyStartIds.add(message.id)
      afterDelivery = false
    }
    projected.push(message)
  }
  return { messages: projected, replyStartIds }
}

export function projectNativeChatTranscriptMessages(
  messages: readonly NativeChatMessage[],
  compare?: (a: NativeChatMessage, b: NativeChatMessage) => number
): NativeChatMessage[] {
  return projectNativeChatTranscript(messages, compare).messages
}
