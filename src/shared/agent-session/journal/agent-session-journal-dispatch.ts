import type { AgentJournalCursor } from './agent-session-journal-identity'

export const AGENT_JOURNAL_DISPATCH_STATES = ['pending', 'accepted', 'rejected', 'unknown'] as const
export type AgentJournalDispatchState = (typeof AGENT_JOURNAL_DISPATCH_STATES)[number]

/** The newest relevant explicit retry, including one outside the current history page. */
export type AgentJournalRetryLineage = {
  clientMessageId: string
  dispatchState: AgentJournalDispatchState
  submittedAt: number
}
/** Durable answer to a send, keyed by client id and preserved beyond the journal tail. */
export type AgentJournalAcceptanceReceipt = {
  clientMessageId: string
  providerItemId: string
  cursor: AgentJournalCursor
  acceptedAt: number
}
