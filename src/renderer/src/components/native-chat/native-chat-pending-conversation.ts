import {
  latestClearSentAt,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import { dropNativeChatPendingOccurrences } from './native-chat-pending-occurrence'

export type NativeChatPendingConversation = {
  /** Provider session currently resolved for the pane; null while unknown. */
  sessionId: string | null
  /** Slash commands recorded for that session (`/clear` resets the transcript). */
  markers: readonly NativeChatCommandMarker[]
}

/**
 * Keep only the echoes that belong to the pane's current conversation.
 *
 * Echoes are cached per pane+agent and clear only by matching a transcript turn,
 * so one left behind when the conversation is replaced (`/clear`, agent restart,
 * resuming another session) can never match and stays pinned at the list tail —
 * an old prompt rendered as the newest message for the rest of the session.
 */
export function retainPendingSendsForConversation(
  pending: NativeChatPendingSend[],
  conversation: NativeChatPendingConversation
): NativeChatPendingSend[] {
  const clearedAt = latestClearSentAt(conversation.markers)
  const { sessionId } = conversation
  const retained = dropNativeChatPendingOccurrences(
    pending,
    (entry) =>
      (clearedAt !== null && entry.sentAt <= clearedAt) ||
      (sessionId !== null && entry.sessionId != null && entry.sessionId !== sessionId)
  )
  // Why: a reconnect can briefly drop provider-session metadata, and the session
  // gate already holds the last identity — don't drop echoes on it. A fresh launch
  // learns its id only after the first send, so the first id observed claims them.
  if (sessionId === null || !retained.some((entry) => entry.sessionId == null)) {
    return retained
  }
  return retained.map((entry) => (entry.sessionId == null ? { ...entry, sessionId } : entry))
}
