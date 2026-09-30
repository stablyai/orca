// The user's Retry on a stuck outbox entry: requeue it, rotating the operation
// id when the recorded one can only ever replay a settled rejection.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

export function retryStructuredAgentSessionOutboxEntry(args: {
  clientMessageId: string
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  outboxRef: { current: StructuredAgentSessionOutboxEntry[] }
  setOutbox: (entries: StructuredAgentSessionOutboxEntry[]) => void
  setError: (error: string | null) => void
  createOperationId: () => string
}): void {
  const { clientMessageId, outboxRef, sessionId, setError, setOutbox, submissions } = args
  const submission = submissions.find((candidate) => candidate.clientMessageId === clientMessageId)
  const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
  // The host settled this id as rejected, and reusing it only replays that forever, so rotate the
  // id for a safe resend. Read from the message itself, which outlives a restart, or from a
  // reconciliation that settled an earlier unknown before the outbox caught up. A refusal that
  // settled the message already rotated it.
  const recordedRejection =
    current?.state === 'rejected' && current.lastFailure?.kind === 'rejected'
  if (current && (recordedRejection || submission?.dispatchState === 'rejected')) {
    const rotated = outboxRef.current.map((entry) =>
      entry.clientMessageId === clientMessageId
        ? {
            ...retriedByUser(entry),
            clientMessageId: args.createOperationId(),
            state: 'queued' as const,
            lastAttemptAt: null,
            retryAfterUnknownSubmittedAt: null
          }
        : entry
    )
    if (!writeOutbox(sessionId, rotated)) {
      setError('Message could not be saved to the outbox')
      return
    }
    outboxRef.current = rotated
    setOutbox(rotated)
    return
  }
  const retryAfterUnknownSubmittedAt =
    submission?.dispatchState === 'unknown'
      ? submission.submittedAt
      : current?.state === 'unconfirmed'
        ? -1
        : null
  const next = outboxRef.current.map((entry) =>
    entry.clientMessageId === clientMessageId
      ? {
          ...retriedByUser(entry),
          state: 'queued' as const,
          retryAfterUnknownSubmittedAt
        }
      : entry
  )
  if (!writeOutbox(sessionId, next)) {
    setError('Message could not be saved to the outbox')
    return
  }
  outboxRef.current = next
  setOutbox(next)
}

/** The user's own Retry is what a Stop left the entry waiting for. */
function retriedByUser({
  outlivedStop: _retried,
  ...entry
}: StructuredAgentSessionOutboxEntry): StructuredAgentSessionOutboxEntry {
  return entry
}
