// Sends the host has accepted that the provider has not started a turn for.
//
// Claude queues a message sent mid-turn inside its own SDK and echoes it only
// when the previous turn ends, so the wait is bounded by that turn and not by
// anything Orca can observe. The durable representation of "accepted but not
// running" already exists — a submission row whose dispatch is still pending —
// so this module reads that state rather than adding a second one.

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
import { selectStructuredAgentRunningTurnTiming } from './structured-agent-session-turn-timing'

/**
 * A send the host has journaled that the provider has neither opened a turn for nor refused.
 *
 * Codex declares `turn/started` within ~150ms, but Claude's running row can only be written once
 * the SDK echoes the user message back — a 3.4s median and 18s at p90 on real journals. Waiting
 * on that echo to call a session working leaves the whole gap reading idle in the chat and in
 * every session list, so the send itself is the evidence.
 *
 * A live `unknown` still counts because an ambiguous adapter reply does not prove the provider
 * stopped. A recovered `unknown` does not — it outlived the host generation that sent it, so
 * there is nothing still running to report.
 */
export function isUnansweredStructuredAgentSessionDispatch(
  submission: AgentJournalSubmission,
  currentFence?: number | null
): boolean {
  return (
    (currentFence == null || submission.fence >= currentFence) &&
    (submission.dispatchState === 'pending' ||
      (submission.dispatchState === 'unknown' &&
        submission.recovered !== true &&
        // Older hosts publish the recovery reason but omit the optional marker.
        submission.reason !== 'host_restarted_before_acknowledgement'))
  )
}

export function hasUnansweredStructuredAgentSessionDispatch(
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return submissions.some((submission) =>
    isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
  )
}

export type StructuredAgentSessionQueuedSend = {
  clientMessageId: string
  /** Host clock at acceptance — the durable submission row's own stamp. */
  submittedAt: number
  /** Why it is still waiting. `turn-busy`: a turn that is not this send's own is
   *  still running. `turn-starting`: nothing is running yet. */
  waitingOn: 'turn-busy' | 'turn-starting'
}

/**
 * The queued sends, keyed by the journal key of the user row each one renders as.
 *
 * A pending submission is queued unless the running turn may be its own. Two
 * facts rule that out, and neither needs the submission's own alias — it has
 * none while it is pending:
 *
 *  - a turn that started BEFORE this send was accepted cannot be its turn;
 *  - a turn another submission already claims by provider key is that one's.
 *
 * Anything else is left out. The dispatch row and the turn row are written by
 * two different async paths off the SAME echo, so a turn briefly exists while
 * its own submission is still pending; reporting that as queued would flicker a
 * line onto the message the provider had in fact just started.
 */
export function selectStructuredAgentSessionQueuedSends(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): ReadonlyMap<string, StructuredAgentSessionQueuedSend> {
  const queued = new Map<string, StructuredAgentSessionQueuedSend>()
  const turnId = activeStructuredAgentSessionTurnId(items)
  const running = turnId === null ? null : selectStructuredAgentRunningTurnTiming(items, turnId)
  const claimedBy = running?.userItemId
    ? submissions.find((entry) => entry.providerItemId === running.userItemId)?.clientMessageId
    : undefined
  for (const submission of submissions) {
    if (!isUnansweredStructuredAgentSessionDispatch(submission, currentFence)) {
      continue
    }
    if (running === null) {
      queued.set(agentJournalSubmissionKey(submission.clientMessageId), {
        clientMessageId: submission.clientMessageId,
        submittedAt: submission.submittedAt,
        waitingOn: 'turn-starting'
      })
      continue
    }
    const othersTurn =
      running.startedAt < submission.submittedAt ||
      (claimedBy !== undefined && claimedBy !== submission.clientMessageId)
    if (othersTurn) {
      queued.set(agentJournalSubmissionKey(submission.clientMessageId), {
        clientMessageId: submission.clientMessageId,
        submittedAt: submission.submittedAt,
        waitingOn: 'turn-busy'
      })
    }
  }
  return queued
}
