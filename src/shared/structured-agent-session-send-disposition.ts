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
import { agentSessionRefusalFailure } from './agent-session-write-failure'
import type { AgentSessionFailureFact } from './agent-session-failure'
import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionSubmissionSettlement } from './structured-agent-session-submission-settlement'
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

/** Whether the journal already answers a send still in flight, so its own reply adds nothing: the
 *  host holds the message, or rejected it — a later `pending` reply must not undo that. */
export function journalAnswersInFlightSend(
  submissions: readonly AgentJournalSubmission[],
  clientMessageId: string | null
): boolean {
  return submissions.some((submission) => submission.clientMessageId === clientMessageId)
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
    ? [{ text: agentSessionFailureSentence({ ...fact, kind }, 'rejection', context) }]
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
    const refusal = agentSessionRefusalFailure(result.refusal)
    const entries = input.entries.map((candidate) =>
      candidate.clientMessageId === input.entry.clientMessageId
        ? withLastFailure(
            requeueStructuredAgentSessionSendRefusal(
              candidate,
              refusal,
              input.createOperationId,
              input.entry.lastAttemptAt !== null
            ),
            refusal
          )
        : candidate
    )
    const refused = entries[refusedIndex]
    return {
      entries,
      error: null,
      // Read back by index rather than from the input: a refusal can rotate the id, and the
      // refused entry is not always the head now that an admitted one no longer holds the queue.
      // A rejected one holds nothing: it can no longer land, and it keeps its own Retry.
      blockedClientMessageId:
        !refused || refused.state === 'rejected'
          ? input.blockedClientMessageId
          : refused.clientMessageId
    }
  }
  const submission = result.value.submission
  const settled = (
    entries: StructuredAgentSessionOutboxEntry[]
  ): StructuredAgentSessionSendDisposition => ({
    entries,
    error: null,
    blockedClientMessageId: input.blockedClientMessageId
  })
  switch (structuredAgentSessionSubmissionSettlement(submission)) {
    // Sent, or left in doubt for good by a crash or a dead agent: the journal draws the message,
    // and sending a new one is how the chat continues.
    case 'sent':
      return settled(dropEntry(input))
    // A Stop's withdrawal failed nothing, first reply or replay: the entry leaves as the
    // reconcile drops it, with no notice. Any other refusal keeps the text for the user's Retry.
    case 'refused':
      return settled(
        classifyDispatchRejection(submission).category === 'withdrawn'
          ? dropEntry(input)
          : replaceEntryState(input, 'rejected', structuredAgentSessionRejectedFailure(submission))
      )
    // `pending` is the host saying the message was written and is awaiting the provider's
    // acknowledgement, which cannot arrive until the turn ahead of it ends. That is not doubt, and
    // keeping order is no longer the reason to hold the entry -- the host fixed the order when it
    // wrote the row. It stays because a `pending`, or a live `unknown`, can still settle
    // `rejected`, and only the entry carries the retry state that answer needs.
    case 'open':
      return settled(replaceEntryState(input, 'dispatching'))
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
      : replaceEntryState(input, 'queued', { kind: 'failed' }),
    error: null,
    blockedClientMessageId: deliveryUnknown
      ? input.blockedClientMessageId
      : input.entry.clientMessageId
  }
}
