import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from './agent-session-journal-types'

/** The turn a conversation command such as `/compact` runs as, keyed by its submission. The queue
 *  reads it too: a refused command card is spent only once this turn has said why. */
export function structuredAgentSessionCommandTurnIdentity(
  clientMessageId: string
): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `command-turn:${clientMessageId}` }
}

/** The command's turn: its record and the `turnId` a Stop names. The `compact:` prefix is how the
 *  host's Stop and delivery gate tell a command's turn from any other. */
export function structuredAgentSessionCommandTurn(clientMessageId: string): {
  identity: AgentJournalItemIdentity
  itemId: string
  turnId: string
  /** The command's one result row, inside its turn. */
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
