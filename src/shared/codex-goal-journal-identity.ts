import { parseAgentJournalItemKey } from './agent-session-journal-item-key'

export type CodexGoalJournalState = {
  thread: string
  signature: string
  occurrence: string
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Recognizes only the host-owned rows used to record Codex goal lifecycle state. */
export function parseCodexGoalJournalItemId(itemId: string): CodexGoalJournalState | null {
  if (!itemId.startsWith('orca:')) {
    return null
  }
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return null
  }
  const [prefix, thread, signature, occurrence, ...rest] = identity.clientMessageId.split(':')
  if (
    prefix !== 'codex-goal' ||
    typeof thread !== 'string' ||
    !DIGEST_PATTERN.test(thread) ||
    typeof signature !== 'string' ||
    !DIGEST_PATTERN.test(signature) ||
    typeof occurrence !== 'string' ||
    !DIGEST_PATTERN.test(occurrence) ||
    rest.length !== 0
  ) {
    return null
  }
  return { thread, signature, occurrence }
}
