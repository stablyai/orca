// The one reading of a journaled send's dispatch facts. Clients, the host's status projection and
// mobile all decide from this; a ratchet test fails on a new raw read of those facts elsewhere,
// because every earlier copy of this rule drifted from the others.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'

/**
 * - `open`: the host still holds it and it can yet turn accepted or rejected — pending, queued, or
 *   a live `unknown`. A client keeps its outbox entry for the answer.
 * - `sent`: drawn as an ordinary sent message with nothing left to hold or retry — the provider
 *   took it, or a crash or dead agent left it in doubt for good and the next message is how the
 *   chat continues. An older host's `notDelivered` was that same doubt, inferred from the
 *   transcript; such a host wrote no session row, so that message carries no notice.
 * - `refused`: provably did not happen; `classifyDispatchRejection` says why.
 */
export type StructuredAgentSessionSubmissionSettlement = 'open' | 'sent' | 'refused'

export function structuredAgentSessionSubmissionSettlement(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'recovered'> & {
    rejection?: unknown
  }
): StructuredAgentSessionSubmissionSettlement {
  const { dispatchState } = submission
  if (dispatchState === 'pending') {
    return 'open'
  }
  if (dispatchState === 'unknown') {
    // Hosts before the `recovered` flag reached the wire publish only the restart reason.
    return submission.recovered === true ||
      submission.reason === 'host_restarted_before_acknowledgement'
      ? 'sent'
      : 'open'
  }
  if (dispatchState === 'rejected') {
    return classifyDispatchRejection(submission).kind === 'notDelivered' ? 'sent' : 'refused'
  }
  // `accepted` — or a state a newer host wrote, since the wire admits any string here: to this
  // build that is doubt, and doubt is drawn as sent.
  return 'sent'
}

/** A Stop withdrew it before it ran: it will not land, and only its sender can send it again. */
export function structuredAgentSessionSubmissionWasWithdrawn(
  submission: Parameters<typeof structuredAgentSessionSubmissionSettlement>[0]
): boolean {
  return (
    structuredAgentSessionSubmissionSettlement(submission) === 'refused' &&
    classifyDispatchRejection(submission).category === 'withdrawn'
  )
}
