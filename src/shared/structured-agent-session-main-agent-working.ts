import type { AgentJournalSubmission } from './agent-session-journal-types'
import { hasUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** The host's answer to which work is current, built only by its operational projection
 *  (`structuredAgentSessionCurrentWork`). A client has none, so every running turn, pending prompt
 *  and unanswered send it holds reads as current, as it always has. */
export type StructuredAgentSessionWorkScope = {
  /** Whether the live generation's execution produced this item. */
  isCurrentItem: (itemId: string) => boolean
  /** Whether this send is still owed: handed to the live generation and unanswered, or accepted by
   *  this host and not yet handed over. */
  owesSend: (submission: AgentJournalSubmission) => boolean
}

/** Whether the session's own agent is working: a running turn, or a send it has not answered.
 *  The one rule behind every session list's Working and the chat's own Stop. A host passes the turn
 *  its projection scoped, and that projection's `scope`. */
export function isStructuredAgentSessionMainAgentWorking(
  activeTurnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): boolean {
  return (
    activeTurnId !== null ||
    (scope
      ? submissions.some(scope.owesSend)
      : hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence))
  )
}
