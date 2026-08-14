import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export type CodexSubagentTranscriptScope = {
  messages: NativeChatMessage[]
  hasMore: boolean
}

export function scopeCodexSubagentTranscript(
  messages: readonly NativeChatMessage[],
  hasMore: boolean,
  startedAt: number
): CodexSubagentTranscriptScope {
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return { messages: [], hasMore: false }
  }
  const firstOwnedMessage = messages.findIndex(
    (message) => message.timestamp !== null && message.timestamp >= startedAt
  )
  if (firstOwnedMessage === -1) {
    return { messages: [], hasMore: false }
  }
  // Why: Codex full-history forks copy parent turns before the provider-authored child start boundary.
  return {
    messages: messages.slice(firstOwnedMessage),
    hasMore: hasMore && firstOwnedMessage === 0
  }
}
