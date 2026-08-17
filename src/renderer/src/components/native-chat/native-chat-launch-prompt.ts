import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  advancedNativeChatUserContentCounts,
  matchingNativeChatUserContentCounts,
  nativeChatPendingContentKey
} from './native-chat-pending-occurrence'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export type NativeChatLaunchPromptMatchOptions = {
  crossClock?: boolean
  transcriptOrder?: NativeChatTranscriptOrder
}

function relevantLaunchPromptMessages(
  entry: NativeChatLaunchPrompt,
  messages: readonly NativeChatMessage[],
  options: NativeChatLaunchPromptMatchOptions
): readonly NativeChatMessage[] {
  if (options.crossClock) {
    // Remote host timestamps are incomparable; sequence marks only post-launch rows.
    const sequenceById = options.transcriptOrder?.messageSequenceById
    // If ordering is not available yet, retain identity/occurrence matching;
    // comparing createdAt to provider timestamps would mix clock domains.
    return sequenceById ? messages.filter((message) => sequenceById.has(message.id)) : messages
  }
  return messages.filter(
    (message) => message.timestamp === null || message.timestamp >= entry.createdAt
  )
}

/** Hide a launch echo once the transcript's matching user turn is visible. */
export function launchPromptAsMessage(
  entry: NativeChatLaunchPrompt | null,
  existingMessages: NativeChatMessage[] = [],
  options: NativeChatLaunchPromptMatchOptions = {}
): NativeChatMessage | null {
  if (!entry) {
    return null
  }
  const represented = matchingNativeChatUserContentCounts(
    relevantLaunchPromptMessages(entry, existingMessages, options)
  )
  if ((represented.get(nativeChatPendingContentKey(entry)) ?? 0) > 0) {
    return null
  }
  return {
    id: `launch-pending:${entry.tabId}`,
    role: 'user',
    blocks: entry.text.trim().length > 0 ? [{ type: 'text', text: entry.text }] : [],
    timestamp: entry.createdAt,
    source: 'scrape'
  }
}

/** Prune only after an assistant turn follows the matching launch prompt. */
export function shouldPruneLaunchPrompt(
  entry: NativeChatLaunchPrompt,
  messages: NativeChatMessage[],
  options: NativeChatLaunchPromptMatchOptions = {}
): boolean {
  const relevant = relevantLaunchPromptMessages(entry, messages, options)
  return (
    (advancedNativeChatUserContentCounts(relevant).get(nativeChatPendingContentKey(entry)) ?? 0) > 0
  )
}

export function isLaunchPromptMessageId(id: string): boolean {
  return id.startsWith('launch-pending:')
}
