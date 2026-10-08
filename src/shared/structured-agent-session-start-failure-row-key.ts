// A failed start's one row is keyed by the start, so a reader finds it by identity, not by its words.

import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from './agent-session-journal-item-key'
import type { AgentJournalItemBody, AgentJournalItemIdentity } from './agent-session-journal-types'

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

/** Whether a start-failure row is a conversation command's: keyed by a sent message that names one.
 *  Its words name the command's next step, so it never speaks for a message's failure. */
export function isStructuredAgentSessionCommandStartFailureRow(
  itemId: string,
  bodyOf: (itemId: string) => AgentJournalItemBody | undefined
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca' || !identity.clientMessageId.startsWith(START_FAILURE_ROW)) {
    return false
  }
  const startKey = identity.clientMessageId.slice(START_FAILURE_ROW.length)
  const body = bodyOf(agentJournalSubmissionKey(startKey))
  return body?.kind === 'message' && body.command !== undefined
}
