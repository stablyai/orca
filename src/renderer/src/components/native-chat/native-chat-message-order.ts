import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { isLaunchPromptMessageId, isPendingMessageId } from './native-chat-pending'

type MessageOrderKey = {
  message: NativeChatMessage
  rank: number
  effectiveTime: number
  inputIndex: number
  transcriptIndex: number
}

export function nativeChatMessageSortRank(message: NativeChatMessage): number {
  if (message.id === NATIVE_CHAT_STREAMING_ID) {
    return 1
  }
  if (isPendingMessageId(message.id) || isLaunchPromptMessageId(message.id)) {
    return 2
  }
  return 0
}

// Claude timestamps queued prompts when they are sent but persists them after the active reply,
// so only those rows inherit the latest transcript time while their provider timestamp stays intact.
export function orderNativeChatMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  let latestTranscriptTime = Number.NEGATIVE_INFINITY
  const keyed = messages.map((message, index): MessageOrderKey => {
    const timestamp = message.timestamp ?? Number.NEGATIVE_INFINITY
    const rank = nativeChatMessageSortRank(message)
    if (message.source === 'transcript' && rank === 0) {
      latestTranscriptTime = Math.max(latestTranscriptTime, timestamp)
    }
    return {
      message,
      rank,
      effectiveTime: message.queued ? latestTranscriptTime : timestamp,
      inputIndex: index,
      transcriptIndex: Number.POSITIVE_INFINITY
    }
  })

  const queuedTimes = new Set(
    keyed.filter(({ message }) => message.queued).map(({ effectiveTime }) => effectiveTime)
  )
  for (const key of keyed) {
    if (key.message.source === 'transcript' && queuedTimes.has(key.effectiveTime)) {
      key.transcriptIndex = key.inputIndex
    }
  }

  keyed.sort(compareMessageOrderKeys)
  return keyed.map(({ message }) => message)
}

function compareMessageOrderKeys(a: MessageOrderKey, b: MessageOrderKey): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank
  }
  if (a.effectiveTime !== b.effectiveTime) {
    return a.effectiveTime - b.effectiveTime
  }
  if (a.transcriptIndex !== b.transcriptIndex) {
    return a.transcriptIndex - b.transcriptIndex
  }
  return a.message.id.localeCompare(b.message.id)
}
