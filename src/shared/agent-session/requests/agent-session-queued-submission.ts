import { readAgentSessionFailureFact } from '../failures/agent-session-failure'
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

/** Prove no delivery from a host-held send or explicit settlement proof; older hosts sent immediately, so missing handover there proves nothing. */
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

/** Still "Sending…" until the host has written it to an idle agent; a send written into a running turn waits for its echo. */
export function agentJournalSubmissionAwaitsAgent(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'writtenAt'>
): boolean {
  return submission.dispatchState === 'pending' && submission.writtenAt === undefined
}
