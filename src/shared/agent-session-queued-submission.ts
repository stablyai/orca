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
