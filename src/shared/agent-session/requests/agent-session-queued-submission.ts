import type { AgentSessionLatestTurn } from '../agent-session-wire'
import { readAgentSessionFailureFact } from '../failures/agent-session-failure'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
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

/** Still "Sending…": not yet handed over, or handed over into another running turn the agent has not read it into.
 *  A send handed to an idle agent has started its turn, as the provider's first reply can take many seconds. */
export function agentJournalSubmissionAwaitsAgent(
  submission: Pick<AgentJournalSubmission, 'clientMessageId' | 'dispatchState' | 'handedOverAt'>,
  latestTurn: Pick<AgentSessionLatestTurn, 'turn'> | null | undefined
): boolean {
  if (submission.dispatchState !== 'pending') {
    return false
  }
  if (submission.handedOverAt === undefined) {
    return true
  }
  return (
    latestTurn?.turn.state === 'running' &&
    latestTurn.turn.userItemId !== agentJournalSubmissionKey(submission.clientMessageId)
  )
}
