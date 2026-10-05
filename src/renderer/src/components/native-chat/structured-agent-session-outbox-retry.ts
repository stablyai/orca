// The user's Retry on a stuck outbox entry: requeue it, rotating the operation
// id when the recorded one can only ever replay a settled rejection.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionEntryIdExpired,
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED } from '../../../../shared/structured-agent-session-send-disposition'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

export function retryStructuredAgentSessionOutboxEntry(args: {
  clientMessageId: string
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  setError: (error: string | null) => void
  createOperationId: () => string
}): void {
  const { clientMessageId, sessionId, setError, submissions } = args
  const submission = submissions.find((candidate) => candidate.clientMessageId === clientMessageId)
  const outbox = getStructuredAgentSessionOutbox(sessionId)
  const current = outbox.find((entry) => entry.clientMessageId === clientMessageId)
  // The host settled this id as rejected, and reusing it only replays that forever, so rotate the
  // id for a safe resend. Read from the message itself, which outlives a restart, or from a
  // reconciliation that settled an earlier unknown before the outbox caught up. A refusal that
  // settled the message already rotated it. An expired id is refused for good; its row told the
  // user to check the chat first.
  const recordedRejection =
    current !== undefined && structuredAgentSessionEntryRejectedByHost(current)
  if (
    current &&
    (recordedRejection ||
      submission?.dispatchState === 'rejected' ||
      structuredAgentSessionEntryIdExpired(current))
  ) {
    const rotated = outbox.map((entry) =>
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
    if (!commitStructuredAgentSessionOutbox(sessionId, rotated, { onlyIfSaved: true })) {
      setError(agentSessionWriteNoticeText(STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED))
    }
    return
  }
  const retryAfterUnknownSubmittedAt =
    submission?.dispatchState === 'unknown'
      ? submission.submittedAt
      : current?.state === 'unconfirmed'
        ? -1
        : null
  const next = outbox.map((entry) =>
    entry.clientMessageId === clientMessageId
      ? {
          ...retriedByUser(entry),
          state: 'queued' as const,
          retryAfterUnknownSubmittedAt
        }
      : entry
  )
  if (!commitStructuredAgentSessionOutbox(sessionId, next, { onlyIfSaved: true })) {
    setError(agentSessionWriteNoticeText(STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED))
  }
}

/** The user's own Retry is what a Stop, or a failure saved on the message, left it waiting for. */
function retriedByUser({
  outlivedStop: _retried,
  lastFailure: _sentAgain,
  ...entry
}: StructuredAgentSessionOutboxEntry): StructuredAgentSessionOutboxEntry {
  return entry
}
