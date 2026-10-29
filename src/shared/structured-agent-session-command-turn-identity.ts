import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from './agent-session-journal-types'

/** Submission-keyed command turn; the queue retains refused cards until this turn records why. */
export function structuredAgentSessionCommandTurnIdentity(
  clientMessageId: string
): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `command-turn:${clientMessageId}` }
}

/** Stop/delivery gates recognize command turns by the compact: prefix. */
export function structuredAgentSessionCommandTurn(clientMessageId: string): {
  identity: AgentJournalItemIdentity
  itemId: string
  turnId: string
  resultIdentity: AgentJournalItemIdentity
} {
  const identity = structuredAgentSessionCommandTurnIdentity(clientMessageId)
  return {
    identity,
    itemId: agentJournalItemKey(identity),
    turnId: `compact:${clientMessageId}`,
    resultIdentity: { provider: 'orca', clientMessageId: `command-result:${clientMessageId}` }
  }
}
