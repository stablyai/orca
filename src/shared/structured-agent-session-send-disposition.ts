// How one send outcome changes the outbox.
//
// The sibling of `reconcileStructuredAgentSessionOutbox`: that one folds the
// journal's view of a submission into the queue, this one folds the answer to a
// single `agentSession.send`. Both write the same state, so they live together
// and speak the same vocabulary. Pure on purpose — the hook that calls this owns
// the refs, the React state and the storage write, and nothing else decides an
// entry's state.

import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  classifyStructuredAgentSessionSendFailure,
  requeueStructuredAgentSessionSendRefusal,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

export type StructuredAgentSessionSendDisposition = {
  entries: StructuredAgentSessionOutboxEntry[]
  error: string | null
  /** The entry the queue is stuck on, or null when nothing blocks it. Always the
   *  next value, never "unchanged": the caller assigns it verbatim. */
  blockedClientMessageId: string | null
}

type SendDispositionInput = {
  entries: readonly StructuredAgentSessionOutboxEntry[]
  entry: StructuredAgentSessionOutboxEntry
  blockedClientMessageId: string | null
}

function replaceEntryState(
  input: SendDispositionInput,
  state: StructuredAgentSessionOutboxEntry['state']
): StructuredAgentSessionOutboxEntry[] {
  return input.entries.map((candidate) =>
    candidate.clientMessageId === input.entry.clientMessageId ? { ...candidate, state } : candidate
  )
}

function dropEntry(input: SendDispositionInput): StructuredAgentSessionOutboxEntry[] {
  return input.entries.filter(
    (candidate) => candidate.clientMessageId !== input.entry.clientMessageId
  )
}

/**
 * The user force-retried and got the same observation back, so the host will not
 * put this message on the wire again — it cannot prove doing so would be a first
 * delivery. Parking the entry would offer a Retry that does nothing in front of
 * a queue nothing can drain, so it leaves the outbox. Nothing is lost from the
 * conversation: the durable submission row already renders the message.
 */
function refusedRedelivery(
  entry: StructuredAgentSessionOutboxEntry,
  submission: AgentSessionSendResult['submission']
): boolean {
  return (
    entry.retryAfterUnknownSubmittedAt !== null &&
    submission.dispatchState === 'unknown' &&
    submission.submittedAt === entry.retryAfterUnknownSubmittedAt
  )
}

export function disposeStructuredAgentSessionSendResult(
  input: SendDispositionInput & {
    result: AgentSessionMutationResult<AgentSessionSendResult>
    createOperationId: () => string
  }
): StructuredAgentSessionSendDisposition {
  const result = input.result
  if (!result.ok) {
    const entries = input.entries.map((candidate) =>
      candidate.clientMessageId === input.entry.clientMessageId
        ? requeueStructuredAgentSessionSendRefusal(
            candidate,
            result.refusal.code,
            input.createOperationId
          )
        : candidate
    )
    return {
      entries,
      error: result.refusal.message,
      blockedClientMessageId: entries[0]?.clientMessageId ?? null
    }
  }
  const submission = result.value.submission
  if (refusedRedelivery(input.entry, submission)) {
    return {
      entries: dropEntry(input),
      error: 'Message delivery is unconfirmed and Orca will not send it again',
      blockedClientMessageId: input.blockedClientMessageId
    }
  }
  if (submission.dispatchState === 'accepted') {
    return {
      entries: dropEntry(input),
      error: null,
      blockedClientMessageId: input.blockedClientMessageId
    }
  }
  if (submission.dispatchState === 'rejected') {
    return {
      entries: replaceEntryState(input, 'queued'),
      error: submission.reason ?? 'Message was not accepted',
      blockedClientMessageId: input.entry.clientMessageId
    }
  }
  // `pending` is the host saying the message was written and is awaiting the
  // provider's acknowledgement, which cannot arrive until the turn ahead of it
  // ends. That is not doubt: the entry stays `dispatching` and the queue behind
  // it keeps its order until the echo settles it.
  return {
    entries: replaceEntryState(
      input,
      submission.dispatchState === 'unknown' ? 'unconfirmed' : 'dispatching'
    ),
    error: null,
    blockedClientMessageId: input.blockedClientMessageId
  }
}

export function disposeStructuredAgentSessionSendFailure(
  input: SendDispositionInput & {
    cause: unknown
    isDeliveryUnknown: (error: unknown) => boolean
  }
): StructuredAgentSessionSendDisposition {
  const failure = classifyStructuredAgentSessionSendFailure(input.cause, input.isDeliveryUnknown)
  const deliveryUnknown = failure === 'delivery-unknown'
  return {
    entries: replaceEntryState(input, deliveryUnknown ? 'unconfirmed' : 'queued'),
    error: deliveryUnknown ? 'Message delivery is unconfirmed' : String(input.cause),
    blockedClientMessageId: deliveryUnknown
      ? input.blockedClientMessageId
      : input.entry.clientMessageId
  }
}
