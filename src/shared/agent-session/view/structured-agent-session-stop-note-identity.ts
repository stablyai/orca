import { parseAgentJournalItemKey } from '../journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../journal/agent-session-journal-identity'

const STOP_NOTE_PREFIX = 'stop:'
export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'

export function structuredAgentSessionStopNoteIdentity(stopKey: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `${STOP_NOTE_PREFIX}${stopKey}` }
}

export function isStructuredAgentSessionStopNote(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(STOP_NOTE_PREFIX)
}
