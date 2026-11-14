import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatPendingMatchingAfter } from './native-chat-pending-occurrence'
import type { NativeChatPendingSend } from './native-chat-pending-sends'

export function messagesAfterPendingBoundary(
  messages: readonly NativeChatMessage[],
  pending: NativeChatPendingSend
): readonly NativeChatMessage[] {
  if (pending.afterMessageId === undefined) {
    return messages
  }
  if (pending.afterMessageId === null) {
    // Why: the send time is this client's clock and row timestamps are the host's (#11519).
    return pending.afterEmptyTranscriptSessionId
      ? messages
      : messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
  }
  const boundaryIndex = messages.findIndex((message) => message.id === pending.afterMessageId)
  if (boundaryIndex !== -1) {
    return messages.slice(boundaryIndex + 1)
  }
  // If paging drops the boundary, use send time rather than binding arbitrary older identical prompts.
  return messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
}

function messageIsAfterPendingTimestamp(
  message: NativeChatMessage,
  pending: NativeChatPendingSend
): boolean {
  // Timestampless transcripts must still retire echoes or queued bubbles remain pinned forever.
  if (message.timestamp === null) {
    return true
  }
  const boundary = nativeChatPendingMatchingAfter(pending)
  // Exclude ties to existing transcript-clock boundaries; local send-time boundaries stay inclusive.
  return pending.afterMessageTimestamp == null
    ? message.timestamp >= boundary
    : message.timestamp > boundary
}
