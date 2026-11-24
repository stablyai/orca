import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
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

export function structuredAgentSessionSendingItemIds(
  pending: readonly { clientMessageId: string; phase?: string }[],
  submissions: readonly AgentJournalSubmission[]
): ReadonlySet<string> {
  const sending = new Set<string>()
  for (const entry of pending) {
    if (entry.phase !== 'unconfirmed') {
      sending.add(agentJournalSubmissionKey(entry.clientMessageId))
    }
  }
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    const heldCard =
      submission.queuedMessageId !== undefined && isQueuedAgentJournalSubmission(submission)
    if (!heldCard && agentJournalSubmissionAwaitsAgent(submission)) {
      sending.add(id)
    } else {
      sending.delete(id)
    }
  }
  return sending
}
