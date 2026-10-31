// Key failure rows by start identity so readers never match by prose.

import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from './agent-session-journal-types'

const START_FAILURE_ROW = 'start-failure:'

export function structuredAgentSessionStartFailureRowIdentity(
  startKey: string
): Extract<AgentJournalItemIdentity, { provider: 'orca' }> {
  return { provider: 'orca', clientMessageId: `${START_FAILURE_ROW}${startKey}` }
}

export function isStructuredAgentSessionStartFailureRow(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(START_FAILURE_ROW)
}
