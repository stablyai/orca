import { readAgentSessionFailureFact } from '../failures/agent-session-failure'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'

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

export type AgentJournalCardSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'queuedMessageId' | 'keptAsQueuedMessageId'
>

/** A refused send its queued card took back: the card, not this row, now holds the request. */
export function agentJournalSubmissionReturnedToCard(
  submission: Omit<AgentJournalCardSubmission, 'clientMessageId'>
): boolean {
  return (
    submission.dispatchState === 'rejected' &&
    (submission.queuedMessageId !== undefined || submission.keptAsQueuedMessageId !== undefined)
  )
}

/** Journal item ids of refused sends their queued cards took back. */
export function agentJournalCardReturnedItemIds(
  submissions: readonly AgentJournalCardSubmission[]
): Set<string> {
  const ids = new Set<string>()
  for (const submission of submissions) {
    if (agentJournalSubmissionReturnedToCard(submission)) {
      ids.add(agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  return ids
}
