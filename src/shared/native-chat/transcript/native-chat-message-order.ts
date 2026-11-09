import type { NativeChatMessage } from '../native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../native-chat-streaming'
import { isLaunchPromptMessageId, isPendingMessageId } from './native-chat-pending-sends'
import {
  compareNativeChatTranscriptMessages,
  orderNativeChatTranscriptEntries
} from './native-chat-transcript-projection'

// Clocks cannot order a null-timestamp preview against a client send or a remote transcript.
function messageSortRank(message: NativeChatMessage): number {
  if (message.pendingBeforeMessage) {
    return 0
  }
  if (message.queued || message.pendingSend === 'queued') {
    return 3
  }
  if (message.id === NATIVE_CHAT_STREAMING_ID) {
    return 2
  }
  if (
    message.pendingSend ||
    isPendingMessageId(message.id) ||
    isLaunchPromptMessageId(message.id)
  ) {
    return 1
  }
  return 0
}

function transcriptSortMessage(message: NativeChatMessage): NativeChatMessage {
  return message.pendingBeforeMessage
    ? { ...message, ...message.pendingBeforeMessage, source: 'transcript' }
    : message
}

function comparePositionedMessages(a: NativeChatMessage, b: NativeChatMessage): number {
  return (
    compareNativeChatTranscriptMessages(a, b) ||
    Number(Boolean(b.pendingBeforeMessage)) - Number(Boolean(a.pendingBeforeMessage))
  )
}

export function compareNativeChatDisplayMessages(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  const rank = messageSortRank(a)
  const difference = rank - messageSortRank(b)
  return (
    difference ||
    (rank === 0 ? comparePositionedMessages(transcriptSortMessage(a), transcriptSortMessage(b)) : 0)
  )
}

export function orderNativeChatDisplayEntries<T>(
  entries: readonly T[],
  messageOf: (entry: T) => NativeChatMessage
): T[] {
  return [0, 1, 2, 3].flatMap((rank) => {
    const tier = entries.filter((entry) => messageSortRank(messageOf(entry)) === rank)
    return rank === 0
      ? orderNativeChatTranscriptEntries(
          tier,
          (entry) => transcriptSortMessage(messageOf(entry)),
          comparePositionedMessages
        )
      : tier
  })
}

export function orderNativeChatDisplayMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return orderNativeChatDisplayEntries(messages, (message) => message)
}
