// Reading a persisted body by the extension rule in agent-session-journal-schemas.ts: it parses (a
// body, block, goal state or approval subject of a kind this build does not know included), or it
// is damage. A sent message is the one closed set: a kind this build does not know is a newer
// build's.

import {
  AGENT_JOURNAL_ITEM_BODY_KINDS,
  isAdmissibleAgentJournalItemBody,
  isAdmissibleAgentJournalMessageBody
} from './agent-session-journal-schemas'
import { isJournalTag } from './agent-session-journal-open-union'

/** `unreadable` is never damage: the caller keeps the row and fails the load as a newer Orca's
 *  chat, as for a newer `v`. */
export type AgentJournalContentVerdict = 'readable' | 'unreadable' | 'malformed'

export function readAgentJournalItemBody(body: unknown): AgentJournalContentVerdict {
  return isAdmissibleAgentJournalItemBody(body) ? 'readable' : 'malformed'
}

/** The same for a submission's body, which only a user message may be. A kind this build does not
 *  know is a newer build's, never sent again here. */
export function readAgentJournalMessageBody(body: unknown): AgentJournalContentVerdict {
  const verdict = readAgentJournalItemBody(body)
  if (verdict !== 'readable' || isAdmissibleAgentJournalMessageBody(body)) {
    return verdict
  }
  const kind = typeof body === 'object' && body !== null && 'kind' in body ? body.kind : undefined
  return isJournalTag(kind) && !AGENT_JOURNAL_ITEM_BODY_KINDS.has(kind) ? 'unreadable' : 'malformed'
}
