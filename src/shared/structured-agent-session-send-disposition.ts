// How one send outcome changes the outbox.
//
// The sibling of `reconcileStructuredAgentSessionOutbox`: that one folds the
// journal's view of a submission into the queue, this one folds the answer to a
// single `agentSession.send`. Both write the same state, so they live together
// and speak the same vocabulary. Pure on purpose — the hook that calls this owns
// the refs, the React state and the storage write, and nothing else decides an
// entry's state.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import {
  agentSessionRefusalFailure,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import {
  classifyStructuredAgentSessionSendFailure,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionRejectedFailure,
  type StructuredAgentSessionAttemptFailure,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

export type StructuredAgentSessionSendDisposition = {
  entries: StructuredAgentSessionOutboxEntry[]
  /** Only for an outcome with no entry left to carry it; a kept entry holds its own failure. */
  error: AgentSessionWriteNoticePart[] | null
}

/** A message this client couldn't store to send; the composer's draft or the row's Retry still
 *  has it. */
export const STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED: readonly AgentSessionWriteNoticePart[] = [
  'messageNotSaved',
  'tryAgain'
]

type SendDispositionInput = {
  entries: readonly StructuredAgentSessionOutboxEntry[]
  entry: StructuredAgentSessionOutboxEntry
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
  submission: AgentJournalSubmission
): boolean {
  return (
    entry.retryAfterUnknownSubmittedAt !== null &&
    submission.dispatchState === 'unknown' &&
    submission.submittedAt === entry.retryAfterUnknownSubmittedAt
  )
}

/** Whether the journal already answers a send still in flight, so its own reply adds nothing: the
 *  host holds the message, rejected it, or handed it off as a queued draft — a later `pending`
 *  reply must not undo that. */
export function journalAnswersInFlightSend(
  submissions: readonly AgentJournalSubmission[],
  clientMessageId: string | null
): boolean {
  return submissions.some(
    (submission) =>
      (submission.clientMessageId === clientMessageId && submission.dispatchState !== 'unknown') ||
      (clientMessageId !== null && submission.queuedMessageId === clientMessageId)
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
 * happened, and on the phone that the message can be sent again — which it can,
 * because the frame provably never left, so a resend cannot duplicate.
 *
 * The null default claims no cause and no next step, because at that point we know
 * neither: all it asserts is the one thing every rejection shares.
 *
 * Exported because a client without an outbox needs the same copy: the rule about
 * which reasons a person may read is a property of the reason, not of the queue.
 */
export function structuredAgentSessionRejectionNotice(
  reason: string | null,
  write: 'send' | 'composer-send'
): string {
  return agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, write))
}

export function structuredAgentSessionRejectionParts(
  reason: string | null,
  write: 'send' | 'composer-send',
  /** The host's typed fact, which decides when the row carried one. */
  fact?: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext = {}
): AgentSessionWriteNoticePart[] {
  if (fact) {
    return rejectionFactParts(write, fact, context)
  }
  if (reason === null) {
    return ['notDoneSend']
  }
  const rejection = classifyDispatchRejection({ reason })
  if (rejection.kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // A legacy marker is an internal cause with no user-facing meaning; any other reason is a
  // sentence written to be read — the provider's, or the host's own.
  return rejection.kind ? agentSessionWriteNotDoneParts(write) : [{ text: reason }]
}

function rejectionFactParts(
  write: 'send' | 'composer-send',
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] {
  const { kind } = classifyDispatchRejection({ reason: null, rejection: fact })
  if (kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // A fact this build cannot place proves only that the message did not happen.
  return kind
    ? [{ failure: { ...fact, kind }, surface: 'rejection', context }]
    : agentSessionWriteNotDoneParts(write)
}

/** Kinds whose words need what the message's copy drops: the provider's detail, or the refusal. */
const WORDED_FROM_WHOLE_FACT: ReadonlySet<AgentSessionFailureFact['kind']> = new Set<
  AgentSessionFailureFact['kind']
>(['providerRejected', 'startFailed', 'restartFailed'])

/** What the Retry row says about why its message did not go through. */
export function structuredAgentSessionAttemptFailureParts(
  failure: StructuredAgentSessionAttemptFailure,
  context: AgentSessionFailureWordsContext = {},
  /** The journal's whole fact for a recorded rejection, when its submission is loaded: the
   *  message's own copy keeps only its kind and attachment. */
  recorded?: AgentSessionFailureFact
): AgentSessionWriteNoticePart[] {
  if (failure.kind !== 'rejected') {
    return agentSessionWriteNoticeParts(failure, 'send', context)
  }
  const fact = recorded ?? failure.rejection
  // Without the journal's fact, the host's sentence still holds what the copy dropped.
  if (!recorded && fact && WORDED_FROM_WHOLE_FACT.has(fact.kind) && failure.reason !== null) {
    return [{ text: failure.reason }]
  }
  return structuredAgentSessionRejectionParts(failure.reason, 'send', fact, context)
}

/** A send the host refused, whether it returned the refusal or threw it. */
export function disposeStructuredAgentSessionSendRefusal(
  input: SendDispositionInput & {
    refusal: AgentSessionWriteRefusal
    createOperationId: () => string
  }
): StructuredAgentSessionSendDisposition {
  // The refusal saved on a message it keeps `queued` is what holds it for the user's Retry.
  const entries: StructuredAgentSessionOutboxEntry[] = input.entries.map((candidate) =>
    candidate.clientMessageId === input.entry.clientMessageId
      ? withLastFailure(
          requeueStructuredAgentSessionSendRefusal(
            candidate,
            input.refusal,
            input.createOperationId,
            input.entry.lastAttemptAt !== null
          ),
          input.refusal
        )
      : candidate
  )
  return { entries, error: null }
}

export function disposeStructuredAgentSessionSendResult(
  input: SendDispositionInput & {
    result: AgentSessionMutationResult<AgentSessionSendResult>
    createOperationId: () => string
  }
): StructuredAgentSessionSendDisposition {
  const result = input.result
  if (!result.ok) {
    return disposeStructuredAgentSessionSendRefusal({
      ...input,
      refusal: agentSessionRefusalFailure(result.refusal)
    })
  }
  if ('queued' in result.value) {
    // The host holds the draft (or already settled it, on a replay). Either way
    // the send is spent and the queue owns it now: the outbox entry retires,
    // and the draft card — not this queue — carries any later refusal.
    return {
      entries: dropEntry(input),
      error: null
    }
  }
  const submission = result.value.submission
  // A replay of a send the host queued and then handed off answers with that hand-off, under its
  // own id: the host owns the message, and the entry leaves as the reconcile drops it.
  if (submission.queuedMessageId === input.entry.clientMessageId) {
    return {
      entries: dropEntry(input),
      error: null
    }
  }
  if (refusedRedelivery(input.entry, submission)) {
    return {
      entries: dropEntry(input),
      error: ['sendOutcomeLost']
    }
  }
  if (submission.dispatchState === 'accepted') {
    return {
      entries: dropEntry(input),
      error: null
    }
  }
  // A Stop's withdrawal failed nothing, first reply or replay: the entry leaves as the reconcile
  // drops it, with no notice.
  if (
    submission.dispatchState === 'rejected' &&
    classifyDispatchRejection(submission).category === 'withdrawn'
  ) {
    return {
      entries: dropEntry(input),
      error: null
    }
  }
  // The host kept it as a card, first reply or replay: the card owns the text, so the entry
  // leaves as the reconcile drops it, with no Retry that could send words the card's Delete took.
  if (submission.dispatchState === 'rejected' && submission.keptAsQueuedMessageId !== undefined) {
    return {
      entries: dropEntry(input),
      error: null
    }
  }
  if (submission.dispatchState === 'rejected') {
    return {
      entries: replaceEntryState(
        input,
        'rejected',
        structuredAgentSessionRejectedFailure(submission)
      ),
      error: null
    }
  }
  if (submission.dispatchState === 'unknown' && submission.recovered) {
    return {
      entries: input.entries.map((candidate) =>
        candidate.clientMessageId === input.entry.clientMessageId
          ? { ...candidate, state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }
          : candidate
      ),
      error: null
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
    error: null
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
    // An unconfirmed entry's Retry row already says delivery is unconfirmed; the saved failure
    // holds the other for its Retry.
    entries: deliveryUnknown
      ? replaceEntryState(input, 'unconfirmed')
      : replaceEntryState(input, 'queued', { kind: 'failed' }),
    error: null
  }
}
