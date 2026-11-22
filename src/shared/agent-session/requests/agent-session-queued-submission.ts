import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../failures/agent-session-failure'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'

/** Accepted but not handed over proves unwritten; only delivery/rejection can follow, never doubt. */
export function isQueuedAgentJournalSubmission(
  submission: Pick<AgentJournalSubmission, 'handoverRecorded' | 'dispatchState' | 'handedOverAt'>
): boolean {
  return (
    submission.handoverRecorded === true &&
    submission.dispatchState === 'pending' &&
    submission.handedOverAt === undefined
  )
}

/** The rejection, when it proves the send never reached the agent and no turn answered it. */
function rejectionBeforeAgent(
  submission: Pick<AgentJournalSubmission, 'rejection' | 'answeredInTurn'>
): AgentSessionFailureFact | undefined {
  const rejection = readAgentSessionFailureFact(submission.rejection)
  return rejection?.neverReachedAgent === true && !submission.answeredInTurn ? rejection : undefined
}

/** Prove no delivery from a host-held send or explicit settlement proof; older hosts sent immediately, so missing handover there proves nothing. */
export function agentJournalSubmissionProvenUnwritten(
  submission: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'handedOverAt' | 'rejection' | 'answeredInTurn'
  >
): boolean {
  return (
    (submission.handoverRecorded === true && submission.handedOverAt === undefined) ||
    rejectionBeforeAgent(submission) !== undefined
  )
}

/** A queued send rejected as not delivered before the agent saw it: its card waits again. */
export function isSentBackQueuedAgentJournalSubmission(
  submission:
    | Pick<
        AgentJournalSubmission,
        'dispatchState' | 'queuedMessageId' | 'rejection' | 'answeredInTurn'
      >
    | undefined
): boolean {
  return (
    submission?.dispatchState === 'rejected' &&
    submission.queuedMessageId !== undefined &&
    rejectionBeforeAgent(submission)?.kind === 'notDelivered'
  )
}
