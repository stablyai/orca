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

/**
 * Inverse of {@link agentJournalItemKey}. Clients hold item KEYS, but an upsert
 * needs the identity behind one — answering an approval re-appends the same
 * item at the next revision. Every component is percent-encoded, and
 * `encodeURIComponent` escapes the delimiter, so the split is unambiguous.
 */
export function parseAgentJournalItemKey(key: string): AgentJournalItemIdentity | null {
  const parts = key.split(KEY_DELIMITER).map((part) => decodeURIComponent(part))
  const [provider, ...rest] = parts
  if (provider === 'codex' && rest.length === 3) {
    const ordinal = Number(rest[2])
    return Number.isSafeInteger(ordinal) && ordinal >= 0
      ? { provider, threadId: rest[0] as string, turnId: rest[1] as string, ordinal }
      : null
  }
  if (provider === 'claude' && rest.length === 2) {
    return { provider, sessionId: rest[0] as string, uuid: rest[1] as string }
  }
  if (provider === 'orca' && rest.length === 1) {
    return { provider, clientMessageId: rest[0] as string }
  }
  if (provider === 'legacy' && rest.length === 3) {
    return {
      provider,
      agent: rest[0] as string,
      sessionId: rest[1] as string,
      recordId: rest[2] as string
    }
  }
  return null
}
