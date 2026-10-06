// A message this client did not send — one the host sent itself, such as a restart's continuation,
// or one another device sent — whose start failed for good. No outbox entry here shows it, so the
// chat shows it from the journal, on a host that can queue it again: an unsent message that says
// why, whose Retry queues that same message again.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { failedBeforeHandover } from './structured-agent-session-dispatch-rejection'

export function failedStartsSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]
): AgentJournalSubmission[] {
  const sentHere = new Set(outbox.map((entry) => entry.clientMessageId))
  return submissions.filter(
    (submission) =>
      !sentHere.has(submission.clientMessageId) &&
      // A queued card's message: the card shows it, and its own Retry is the card's.
      submission.queuedMessageId === undefined &&
      failedBeforeHandover(submission) &&
      !sentAgainSince(submission, submissions)
  )
}

/** The same words went through since, as a message of their own: an older host's Retry sent a new
 *  copy under a new id. A copy's body is the original's, so its body-only fingerprint matches. */
function sentAgainSince(
  original: AgentJournalSubmission,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return submissions.some(
    (later) =>
      later.clientMessageId !== original.clientMessageId &&
      later.payloadFingerprint === original.payloadFingerprint &&
      later.submittedAt > original.submittedAt &&
      (later.dispatchState === 'accepted' || later.handedOverAt !== undefined)
  )
}
