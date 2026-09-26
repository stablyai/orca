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
  agentSessionRefusalFailure,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts,
  type AgentSessionWriteNoticePart
} from './agent-session-refusal-notice'
import {
  dispatchRejectionReasonIsInternal,
  dispatchRejectionWasTransportWriteFailure
} from './structured-agent-session-dispatch-rejection'
import {
  classifyStructuredAgentSessionSendFailure,
  requeueStructuredAgentSessionSendRefusal,
  type StructuredAgentSessionAttemptFailure,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

export type StructuredAgentSessionSendDisposition = {
  entries: StructuredAgentSessionOutboxEntry[]
  /** Only for an outcome with no entry left to carry it; a kept entry holds its own failure. */
  error: string | null
  /** The entry the queue is stuck on, or null when nothing blocks it. Always the
   *  next value, never "unchanged": the caller assigns it verbatim. */
  blockedClientMessageId: string | null
  /** A rejected result arrived before the journal snapshot; Retry must rotate this id. */
  retryWithFreshClientMessageId: string | null
}

type SendDispositionInput = {
  entries: readonly StructuredAgentSessionOutboxEntry[]
  entry: StructuredAgentSessionOutboxEntry
  blockedClientMessageId: string | null
}

function replaceEntryState(
  input: SendDispositionInput,
  state: StructuredAgentSessionOutboxEntry['state'],
  lastFailure?: StructuredAgentSessionAttemptFailure
): StructuredAgentSessionOutboxEntry[] {
  return input.entries.map((candidate) =>
    candidate.clientMessageId === input.entry.clientMessageId
      ? withLastFailure({ ...candidate, state }, lastFailure)
      : candidate
  )
}

function withLastFailure(
  entry: StructuredAgentSessionOutboxEntry,
  lastFailure: StructuredAgentSessionAttemptFailure | undefined
): StructuredAgentSessionOutboxEntry {
  const { lastFailure: _previous, ...rest } = entry
  return lastFailure === undefined ? rest : { ...rest, lastFailure }
}

function dropEntry(input: SendDispositionInput): StructuredAgentSessionOutboxEntry[] {
  return input.entries.filter(
    (candidate) => candidate.clientMessageId !== input.entry.clientMessageId
  )
}

/**
 * The user force-retried a host-confirmed `unknown` and got the same submission
 * back. That is now the only answer such a retry can get: `unknown` means the
 * host cannot tell whether the provider has the message, and no reason it
 * records ever makes a second delivery safe. Parking the entry would offer a
 * Retry that does nothing in front of a queue nothing can drain, so it leaves
 * the outbox. Nothing is lost from the conversation: the durable submission row
 * already renders the message.
 *
 * A `rejected` submission takes the other path — the message provably did not
 * happen, so Retry rotates the id and sends it as a genuinely new message.
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

/**
 * What to put on screen for a rejection.
 *
 * A content rejection's reason is the provider explaining itself, so it is shown
 * verbatim — "Claude does not support the image type .bmp" is the whole answer and
 * a generic string would throw it away. A transport rejection's reason is an
 * internal marker; printing it put `provider_write_failed: broken pipe` in front of
 * users, which names nothing they can act on. That case gets copy that says what
 * happened and that the message is safe to send again — which it is, because the
 * frame provably never left, so a resend cannot duplicate.
 *
 * The null default claims no cause, because at that point we know none: all it
 * asserts is the one thing every rejection shares.
 *
 * Exported because a client without an outbox needs the same copy: the rule about
 * which reasons a person may read is a property of the reason, not of the queue.
 */
export function structuredAgentSessionRejectionNotice(reason: string | null): string {
  return agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason))
}

export function structuredAgentSessionRejectionParts(
  reason: string | null
): AgentSessionWriteNoticePart[] {
  if (reason === null) {
    return ['messageNotSent']
  }
  if (dispatchRejectionWasTransportWriteFailure(reason)) {
    return ['rejectedUnreachable']
  }
  // Any other reason we minted is an internal cause with no user-facing meaning;
  // only a provider's own explanation is worth reading verbatim.
  return dispatchRejectionReasonIsInternal(reason) ? ['rejectedInternal'] : [{ text: reason }]
}

/** What the Retry row says about why its message did not go through. */
export function structuredAgentSessionAttemptFailureParts(
  failure: StructuredAgentSessionAttemptFailure
): AgentSessionWriteNoticePart[] {
  return failure.kind === 'rejected'
    ? structuredAgentSessionRejectionParts(failure.reason)
    : agentSessionWriteNoticeParts(failure, 'send')
}

export function disposeStructuredAgentSessionSendResult(
  input: SendDispositionInput & {
    result: AgentSessionMutationResult<AgentSessionSendResult>
    createOperationId: () => string
  }
): StructuredAgentSessionSendDisposition {
  const result = input.result
  if (!result.ok) {
    const refusedIndex = input.entries.findIndex(
      (candidate) => candidate.clientMessageId === input.entry.clientMessageId
    )
    const entries = input.entries.map((candidate) =>
      candidate.clientMessageId === input.entry.clientMessageId
        ? withLastFailure(
            requeueStructuredAgentSessionSendRefusal(
              candidate,
              result.refusal.code,
              input.createOperationId,
              input.entry.lastAttemptAt !== null
            ),
            agentSessionRefusalFailure(result.refusal)
          )
        : candidate
    )
    return {
      entries,
      error: null,
      // Read back by index rather than from the input: a refusal can rotate the id, and the
      // refused entry is not always the head now that an admitted one no longer holds the queue.
      blockedClientMessageId: entries[refusedIndex]?.clientMessageId ?? null,
      retryWithFreshClientMessageId: null
    }
  }
  const submission = result.value.submission
  if (refusedRedelivery(input.entry, submission)) {
    return {
      entries: dropEntry(input),
      error: 'Message delivery is unconfirmed and Orca will not send it again',
      blockedClientMessageId: input.blockedClientMessageId,
      retryWithFreshClientMessageId: null
    }
  }
  if (submission.dispatchState === 'accepted') {
    return {
      entries: dropEntry(input),
      error: null,
      blockedClientMessageId: input.blockedClientMessageId,
      retryWithFreshClientMessageId: null
    }
  }
  if (submission.dispatchState === 'rejected') {
    return {
      entries: replaceEntryState(input, 'queued', {
        kind: 'rejected',
        reason: submission.reason
      }),
      error: null,
      blockedClientMessageId: input.entry.clientMessageId,
      retryWithFreshClientMessageId: input.entry.clientMessageId
    }
  }
  if (submission.dispatchState === 'unknown' && submission.recovered) {
    return {
      entries: input.entries.map((candidate) =>
        candidate.clientMessageId === input.entry.clientMessageId
          ? { ...candidate, state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }
          : candidate
      ),
      error: null,
      blockedClientMessageId: input.blockedClientMessageId,
      retryWithFreshClientMessageId: null
    }
  }
  // `pending` is the host saying the message was written and is awaiting the
  // provider's acknowledgement, which cannot arrive until the turn ahead of it
  // ends. That is not doubt, and keeping order is no longer the reason to hold
  // the entry -- the host fixed the order when it wrote the row. It stays
  // because a `pending` can still settle `rejected` or `unknown`, and only the
  // entry carries the retry state that answer needs.
  return {
    entries: replaceEntryState(
      input,
      submission.dispatchState === 'unknown' ? 'unconfirmed' : 'dispatching'
    ),
    error: null,
    blockedClientMessageId: input.blockedClientMessageId,
    retryWithFreshClientMessageId: null
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
    // An unconfirmed entry's Retry row already says delivery is unconfirmed.
    entries: deliveryUnknown
      ? replaceEntryState(input, 'unconfirmed')
      : replaceEntryState(input, 'queued', { kind: 'unreachable' }),
    error: null,
    blockedClientMessageId: deliveryUnknown
      ? input.blockedClientMessageId
      : input.entry.clientMessageId,
    retryWithFreshClientMessageId: null
  }
}
