import {
  latestClearSentAt,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import { renumberNativeChatPendingOccurrences } from './native-chat-pending-occurrence'

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
  let dropped = false
  let adopted = false
  const next: NativeChatPendingSend[] = []
  for (const entry of pending) {
    if (clearedAt !== null && entry.sentAt <= clearedAt) {
      dropped = true
      continue
    }
    // Why: a reconnect can briefly drop provider-session metadata, and the
    // session gate already holds the last identity — don't drop echoes on it.
    if (sessionId === null || entry.sessionId === sessionId) {
      next.push(entry)
      continue
    }
    if (entry.sessionId == null) {
      // Why: a fresh launch learns its session id only after the first send, so
      // the first id observed claims those echoes instead of dropping them.
      next.push({ ...entry, sessionId })
      adopted = true
      continue
    }
    dropped = true
  }
  // Why: a dropped echo's turn will never arrive, so leaving a survivor numbered
  // past it would keep demanding a transcript occurrence that cannot exist.
  // Adoption alone drops nothing, and renumbering it would erase the elevation a
  // capped-out predecessor still owns (its send landed; its turn is still coming).
  if (dropped) {
    return renumberNativeChatPendingOccurrences(next)
  }
  return adopted ? next : pending
}
