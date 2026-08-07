import {
  latestClearSentAt,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import { nativeChatPendingMatchKey } from './native-chat-pending-occurrence'

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
  // Why: a dropped echo's turn will never arrive, so each later sibling sharing
  // its match key must give up exactly the slots those drops freed — counted per
  // key, so an unrelated drop cannot erase elevation a landed turn already earned.
  const droppedByKey = new Map<string, number>()
  let changed = false
  const next: NativeChatPendingSend[] = []
  for (const entry of pending) {
    const replacedSession =
      sessionId !== null && entry.sessionId != null && entry.sessionId !== sessionId
    if ((clearedAt !== null && entry.sentAt <= clearedAt) || replacedSession) {
      const key = nativeChatPendingMatchKey(entry)
      droppedByKey.set(key, (droppedByKey.get(key) ?? 0) + 1)
      changed = true
      continue
    }
    // Why: a reconnect can briefly drop provider-session metadata, and the
    // session gate already holds the last identity — don't drop echoes on it. A
    // fresh launch learns its id only after the first send, so the first id
    // observed claims those echoes instead of dropping them.
    let kept = entry
    if (sessionId !== null && entry.sessionId == null) {
      kept = { ...entry, sessionId }
      changed = true
    }
    const shift = droppedByKey.get(nativeChatPendingMatchKey(kept)) ?? 0
    const occurrence = kept.matchingOccurrence
    if (shift > 0 && occurrence !== undefined) {
      kept = { ...kept, matchingOccurrence: Math.max(1, occurrence - shift) }
      changed = true
    }
    next.push(kept)
  }
  return changed ? next : pending
}
