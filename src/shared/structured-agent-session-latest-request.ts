// The session's latest request and what became of it: the verdict a sidebar row reports once
// the session is idle, and whether there is a request to list at all.
//
// A request is either a turn, whose record carries the provider's verdict, or a send that never
// became one because the agent or its start refused it. A send inside a running turn (a steer)
// is not a request of its own: the turn it joined answers for it.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { dispatchRejectionVerdict } from './structured-agent-session-dispatch-rejection'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

export type StructuredAgentSessionLatestRequest = {
  /** Null while the turn runs, and for a turn whose end carried no verdict. */
  outcome: AgentJournalTurnOutcome | null
  /** When it settled: the turn's end, or the refusal. Undefined while it runs. */
  settledAt: number | undefined
}

/** Null when the journal holds no request with a verdict to give. Accepted and unanswered sends
 *  are passed over — the session is working until their turn records — and so are sends that
 *  failed nobody (withdrawn, or left undelivered by a restart or a close). */
export function latestStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionLatestRequest | null {
  const rejected = rejectedSubmissionsByItem(submissions)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || !isRootAgentJournalItem(item)) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      return {
        outcome: readAgentJournalTurnOutcome(turn),
        settledAt: turn.state === 'running' ? undefined : turnEndedAt(item, turn)
      }
    }
    const submission = rejected.get(item.itemId)
    if (
      submission &&
      dispatchRejectionVerdict(submission.reason) === 'failure' &&
      !deliveredIntoRunningTurn(items, index, submission)
    ) {
      return { outcome: 'failure', settledAt: submission.resolvedAt ?? undefined }
    }
  }
  return null
}

/** Whether the session has a request to list. A send that failed nobody and never became a turn
 *  leaves nothing to report, so a session holding only those is not listed; a user message the
 *  provider journaled itself (history, an older host) still is. Deliberately NOT scoped by
 *  producer: a session whose only content came from a subagent still has content. */
export function hasStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  const sent = new Set(
    submissions.map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  return (
    items.some(
      (item) =>
        readAgentJournalTurn(item.body) !== null ||
        (item.body.kind === 'message' &&
          (item.body.role === 'assistant' || (item.body.role === 'user' && !sent.has(item.itemId))))
    ) ||
    submissions.some(
      (submission) =>
        submission.dispatchState === 'accepted' ||
        isUnansweredStructuredAgentSessionDispatch(submission, currentFence) ||
        (submission.dispatchState === 'rejected' &&
          dispatchRejectionVerdict(submission.reason) === 'failure')
    )
  )
}

function rejectedSubmissionsByItem(
  submissions: readonly AgentJournalSubmission[]
): Map<string, AgentJournalSubmission> {
  const rejected = new Map<string, AgentJournalSubmission>()
  for (const submission of submissions) {
    if (submission.dispatchState === 'rejected') {
      rejected.set(agentJournalSubmissionKey(submission.clientMessageId), submission)
    }
  }
  return rejected
}

/** A send handed over while the turn before it was still running joined that turn. Read off the
 *  host clock, because a turn record's end revises it in place and keeps no sequence of its own.
 *  A send never handed over reached no turn. */
function deliveredIntoRunningTurn(
  items: readonly AgentJournalRenderItem[],
  index: number,
  submission: AgentJournalSubmission
): boolean {
  // Older hosts dispatched a send as they recorded it.
  const deliveredAt =
    submission.handedOverAt ?? (submission.handoverRecorded ? undefined : submission.submittedAt)
  if (deliveredAt === undefined) {
    return false
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const item = items[previous]
    const turn = readAgentJournalTurn(item?.body)
    if (item && turn) {
      const endedAt = turnEndedAt(item, turn)
      return turn.state === 'running' || (endedAt !== undefined && endedAt > deliveredAt)
    }
  }
  return false
}

/** A turn recovery settled ended when that settle was written: when the user learns it stopped. */
function turnEndedAt(
  item: AgentJournalRenderItem,
  turn: AgentJournalTurnLifecycle
): number | undefined {
  return item.recoveredAt ?? turn.completedAt
}
