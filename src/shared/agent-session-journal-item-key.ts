// Item-identity → stable journal key. Pure and shared: the host keys upserts
// with it and clients reconcile optimistic sends against the same string.
//
// Components are percent-encoded before joining so a value containing the
// delimiter cannot collide with a different identity.

import type { AgentJournalItemIdentity } from './agent-session-journal-types'

const KEY_DELIMITER = ':'

function encodePart(value: string | number): string {
  return encodeURIComponent(String(value))
}

/**
 * Stable string key for an item identity.
 *
 * Codex renumbers `item-N` ids on every resume, so its key is the thread, the
 * turn, and the item's ordinal WITHIN that turn — a position that survives
 * renumbering because a completed turn's item list does not change. `thread/fork`
 * copies turns keeping their original turn ids, so the thread id must stay in the
 * key. Claude copies item uuids on `--fork-session`, so its key is the session id
 * plus the uuid. Text never participates.
 */
export function agentJournalItemKey(identity: AgentJournalItemIdentity): string {
  if (identity.provider === 'codex') {
    return [
      'codex',
      encodePart(identity.threadId),
      encodePart(identity.turnId),
      encodePart(identity.ordinal)
    ].join(KEY_DELIMITER)
  }
  if (identity.provider === 'claude') {
    return ['claude', encodePart(identity.sessionId), encodePart(identity.uuid)].join(KEY_DELIMITER)
  }
  if (identity.provider === 'orca') {
    return ['orca', encodePart(identity.clientMessageId)].join(KEY_DELIMITER)
  }
  return [
    'legacy',
    encodePart(identity.agent),
    encodePart(identity.sessionId),
    encodePart(identity.recordId)
  ].join(KEY_DELIMITER)
}

/** Key for the pre-dispatch submission placeholder, before any provider echo. */
export function agentJournalSubmissionKey(clientMessageId: string): string {
  return agentJournalItemKey({ provider: 'orca', clientMessageId })
}
