import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentJournalBodyLookup } from './structured-agent-session-command-entry'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { latestStructuredAgentSessionReportedMessage } from './structured-agent-session-latest-request'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** The answer a status shows; none while a send waits for its turn to open, since the newest answer predates it. */
export function currentStructuredAgentSessionAnswer(
  items: readonly AgentJournalRenderItem[],
  /** The session's sends while its status is working, else none: an idle status (a send released
   *  in doubt, or one the live child no longer holds) owes no send and keeps its answer. */
  workingSends: readonly AgentJournalSubmission[],
  bodyOf: AgentJournalBodyLookup | undefined,
  botSession: boolean,
  currentFence?: number | null
): string {
  // Claude journals a send only when it echoes it, seconds later. A send queued behind a running turn is not waiting on it.
  const awaitingTurn = workingSends.some(
    (submission) =>
      !isQueuedAgentJournalSubmission(submission) &&
      isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
  )
  return awaitingTurn ? '' : latestStructuredAgentSessionReportedMessage(items, bodyOf, botSession)
}
