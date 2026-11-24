import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import {
  structuredAgentSubmissionIndex,
  type StructuredAgentSubmission,
  type SubmissionReceipts
} from './structured-agent-session-submissions'
import {
  agentJournalSubmissionAwaitsAgent,
  isQueuedAgentJournalSubmission
} from '../requests/agent-session-queued-submission'

/** Keep the running clock through a pending notice while hiding the Working indicator. */
export function nativeChatWorkingPresentation(
  working: boolean,
  startedAt: number | null | undefined,
  structured: boolean,
  sendPending: boolean
): { isWorking: boolean; turnWorking: boolean } {
  const isWorking = working && (!structured || startedAt != null)
  return { isWorking, turnWorking: isWorking && !sendPending }
}

/** Host-held cards and local requests expected to become cards stay out of the transcript. */
export function pendingSendsOutsideQueuedCards<
  Send extends { clientMessageId: string; delivery?: 'queue-if-active'; phase?: string }
>(pending: readonly Send[], heldIds: readonly string[], isWorking: boolean): readonly Send[] {
  const held = new Set(heldIds)
  const next = pending.filter(
    (entry) =>
      !held.has(entry.clientMessageId) &&
      !(isWorking && entry.delivery === 'queue-if-active' && entry.phase !== 'unconfirmed')
  )
  return next.length === pending.length ? pending : next
}

const sendingCandidates = new WeakMap<
  readonly StructuredAgentSubmission[],
  readonly StructuredAgentSubmission[]
>()

export function structuredAgentSessionSendingItemIds(
  pending: readonly { clientMessageId: string; phase?: string }[],
  submissions: readonly StructuredAgentSubmission[],
  writtenAtById: SubmissionReceipts
): ReadonlySet<string> {
  let candidates = sendingCandidates.get(submissions)
  if (!candidates) {
    candidates = submissions.filter(
      (submission) =>
        submission.dispatchState === 'pending' &&
        !(submission.queuedMessageId !== undefined && isQueuedAgentJournalSubmission(submission))
    )
    sendingCandidates.set(submissions, candidates)
  }
  const recorded = structuredAgentSubmissionIndex(submissions)
  const sending = new Set<string>()
  for (const entry of pending) {
    if (entry.phase !== 'unconfirmed' && !recorded.has(entry.clientMessageId)) {
      sending.add(agentJournalSubmissionKey(entry.clientMessageId))
    }
  }
  for (const submission of candidates) {
    if (
      agentJournalSubmissionAwaitsAgent(submission, writtenAtById.get(submission.clientMessageId))
    ) {
      sending.add(agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  return sending
}
