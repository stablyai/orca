// Follow journal-schema extension rules: unknown open-union kinds parse; other failures are damage. Unknown sent-message kinds require a newer build.

import {
  AGENT_JOURNAL_ITEM_BODY_KINDS,
  isAdmissibleAgentJournalItemBody,
  isAdmissibleAgentJournalMessageBody
} from './agent-session-journal-schemas'
import { isJournalTag } from './agent-session-journal-open-union'

/** Unreadable means a newer chat, never damage: retain the row and fail the load as for a newer v. */
export type AgentJournalContentVerdict = 'readable' | 'unreadable' | 'malformed'

export function readAgentJournalItemBody(body: unknown): AgentJournalContentVerdict {
  return isAdmissibleAgentJournalItemBody(body) ? 'readable' : 'malformed'
}

/** Submissions accept only user messages; unknown body kinds belong to a newer build and must never be resent. */
export function readAgentJournalMessageBody(body: unknown): AgentJournalContentVerdict {
  const verdict = readAgentJournalItemBody(body)
  if (verdict !== 'readable' || isAdmissibleAgentJournalMessageBody(body)) {
    return verdict
  }
  const kind = typeof body === 'object' && body !== null && 'kind' in body ? body.kind : undefined
  return isJournalTag(kind) && !AGENT_JOURNAL_ITEM_BODY_KINDS.has(kind) ? 'unreadable' : 'malformed'
}
