import { readAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Accepted by the host and not yet handed to the provider: provably unwritten, so every way out
 *  of this state is delivery or a rejection, never doubt. */
export function isQueuedAgentJournalSubmission(
  submission: Pick<AgentJournalSubmission, 'handoverRecorded' | 'dispatchState' | 'handedOverAt'>
): boolean {
  return (
    submission.handoverRecorded === true &&
    submission.dispatchState === 'pending' &&
    submission.handedOverAt === undefined
  )
}

/** Orca can prove the agent never got it: the host still held it, or whoever settled it recorded
 *  that it never reached the agent. A missing hand-off on an older host's send proves nothing:
 *  older hosts sent at once. */
export function agentJournalSubmissionProvenUnwritten(
  submission: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'handedOverAt' | 'rejection' | 'answeredInTurn'
  >
): boolean {
  return (
    (submission.handoverRecorded === true && submission.handedOverAt === undefined) ||
    (readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true &&
      !submission.answeredInTurn)
  )
}
