import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatPendingSend } from './native-chat-pending'

/**
 * Render an optimistic echo after the row it was sent against, not at the tail.
 *
 * Claude consumes a mid-turn send through a `queued_command` attachment and
 * writes no `type:"user"` row for it, so that echo has no row to match — ever.
 * Held at the tail it re-reads below every turn of the reply it triggered, which
 * is what makes the conversation look re-ordered. Mobile anchors for the same
 * reason (`baselineTailMessageId`); desktop already records the boundary as
 * `afterMessageId` and only ever used it for matching.
 *
 * A send still at the tail keeps today's order — after the streaming bubble — so
 * only an echo the transcript has since moved past is repositioned. A boundary
 * paged out by a bounded read falls back to the tail rather than guessing.
 */
export function anchorPendingMessagesToSendBoundary(
  messages: readonly NativeChatMessage[],
  pending: readonly NativeChatPendingSend[],
  pendingMessages: readonly NativeChatMessage[]
): { messages: readonly NativeChatMessage[]; trailing: readonly NativeChatMessage[] } {
  if (pendingMessages.length === 0) {
    return { messages, trailing: pendingMessages }
  }
  const tailId = messages.at(-1)?.id ?? null
  const boundaryByMessageId = new Map(
    pending.map((entry) => [`pending:${entry.id}`, entry.afterMessageId ?? null])
  )
  const presentIds = new Set(messages.map((message) => message.id))
  const anchored = new Map<string, NativeChatMessage[]>()
  const trailing: NativeChatMessage[] = []
  for (const message of pendingMessages) {
    const boundary = boundaryByMessageId.get(message.id) ?? null
    if (boundary === null || boundary === tailId || !presentIds.has(boundary)) {
      trailing.push(message)
      continue
    }
    const sharing = anchored.get(boundary)
    if (sharing) {
      sharing.push(message)
    } else {
      anchored.set(boundary, [message])
    }
  }
  if (anchored.size === 0) {
    return { messages, trailing }
  }
  const placed: NativeChatMessage[] = []
  for (const message of messages) {
    placed.push(message)
    const sharing = anchored.get(message.id)
    if (sharing) {
      placed.push(...sharing)
    }
  }
  return { messages: placed, trailing }
}

/** Transcript, then anything the view renders after it, then the echoes that
 *  still belong at the tail. */
export function nativeChatMessagesWithPending(
  messages: readonly NativeChatMessage[],
  pending: readonly NativeChatPendingSend[],
  pendingMessages: readonly NativeChatMessage[],
  markers: readonly NativeChatMessage[],
  streaming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const anchored = anchorPendingMessagesToSendBoundary(messages, pending, pendingMessages)
  return [...anchored.messages, ...markers, ...streaming, ...anchored.trailing]
}
