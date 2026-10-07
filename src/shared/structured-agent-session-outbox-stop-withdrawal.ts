import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

/** Whether only the user's Retry sends this entry again: a rejected one, one whose send failed or
 *  was refused, one a Stop outlived, or one in doubt the unconfirmed probe leaves alone.
 *  `NativeChatDeliveryRetry` offers it. */
export function awaitsStructuredAgentSessionRetry(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return (
    entry.state === 'rejected' ||
    structuredAgentSessionEntryHeldForRetry(entry) ||
    entry.outlivedStop === true ||
    (entry.state === 'unconfirmed' && entry.retryAfterUnknownSubmittedAt !== null)
  )
}

function unsentStructuredAgentSessionOutboxEntry(
  submissions: readonly AgentJournalSubmission[]
): (entry: StructuredAgentSessionOutboxEntry) => boolean {
  const held = handedOffQueuedMessageIds(submissions)
  for (const submission of submissions) {
    held.add(submission.clientMessageId)
  }
  return (entry) => !held.has(entry.clientMessageId) && !awaitsStructuredAgentSessionRetry(entry)
}

/** A queue send that has gone out at least once and was not refused, in whatever state it now
 *  waits: the host may hold it as a paused draft, so a local restore too would put the same text
 *  in two places. Read from what went on the wire (`sentDelivery`). */
function attemptedQueueSend(entry: StructuredAgentSessionOutboxEntry): boolean {
  return (
    entry.sentDelivery === 'queue-if-active' &&
    entry.lastAttemptAt !== null &&
    entry.state !== 'rejected'
  )
}

/** An attempted queue send a Stop keeps is marked, and its state is left to its answer: nothing
 *  but the user's Retry sends it again (the drain holds a marked `queued` entry, and the probe
 *  skips the mark), since a resend onto the session the user just stopped would start a turn if
 *  the host never got it. */
function markedOutlivingStop(
  entry: StructuredAgentSessionOutboxEntry
): StructuredAgentSessionOutboxEntry {
  return attemptedQueueSend(entry) && entry.outlivedStop !== true
    ? { ...entry, outlivedStop: true }
    : entry
}

/**
 * What a Stop leaves in the outbox: nothing the journal does not already hold may go out after it,
 * so every such entry leaves it, as any send a Stop withdraws does. The send on its way
 * stays: it reaches the host ahead of the Stop, and it comes back from the host's answer, since
 * the agent may already have it. One waiting on Retry keeps it, and so does an issued queue send
 * that has gone out (a queued receipt or hand-off retires it against the published card), and it
 * waits for the user's Retry from then on.
 */
export function withdrawUnsentStructuredAgentSessionOutboxEntries(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  inFlightClientMessageId: string | null
): StructuredAgentSessionOutboxEntry[] {
  const unsent = unsentStructuredAgentSessionOutboxEntry(submissions)
  return entries
    .filter(
      (entry) =>
        entry.clientMessageId === inFlightClientMessageId ||
        !unsent(entry) ||
        attemptedQueueSend(entry)
    )
    .map(markedOutlivingStop)
}

/** Whether a Stop has something here to withdraw: a message that would still go out on its own. */
export function hasUnsentStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return entries.some(unsentStructuredAgentSessionOutboxEntry(submissions))
}
