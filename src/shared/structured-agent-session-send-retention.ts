// When a client may keep, and must give up, the operation id it sent a message under.
//
// The desktop reads the same four dispatch states through
// `disposeStructuredAgentSessionSendResult`; a client with no outbox has no queue
// to move, so it needs only two facts: the outcome to report, and whether the
// operation id it sent under is spent.
//
// The id is the whole safety mechanism here. A client keys its retained ids by
// intent (`structuredAgentSessionSendIntentKey`), so re-sending the same text
// reuses the id — and one id is one delivery: `performSend` answers a second
// request under a recorded id from the ledger and never puts it back on the wire.
// Releasing the id turns that replay into a genuine second delivery, which is why
// only a settled answer releases it:
//
//   accepted/pending — the send happened. The id is spent; a later identical
//     message is a new message and must carry a new id.
//   rejected — a terminal refusal or rejected submission spends a fresh id. A
//     pending-admission refusal, or any refusal after earlier transport doubt,
//     keeps it because neither proves a retained delivery did not happen. The
//     one exception is a host that refuses the replay's request shape itself
//     (an older host's strict schema turning `delivery` away): that host can
//     never accept the replay, so keeping the id would only refuse every later
//     send of the same text.
//   unknown — the one answer that KEEPS its id, whether it came from the host or
//     from an ack-loss on the way back. The message may be with the provider, so
//     the retry has to stay a replay. Rotating here is what sent one message to a
//     model five times.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionSendResult } from './agent-session-wire'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'
import type { StructuredAgentSessionAttachment } from './structured-agent-session-outbox'
import {
  structuredAgentSessionDomainFingerprint,
  type StructuredAgentSessionMutationCallResult
} from './structured-agent-session-mutation'
import { structuredAgentSessionRejectionNotice } from './structured-agent-session-send-disposition'

/** 'queued' = the host holds the message as a queued draft, so it shows as a
 *  card above the composer, never a transcript echo. */
export type StructuredAgentSessionSendOutcome = 'accepted' | 'rejected' | 'unknown' | 'queued'

export type StructuredAgentSessionSendDelivery = {
  outcome: StructuredAgentSessionSendOutcome
  /** True when a retry is safe under a fresh operation id. */
  operationIdSpent: boolean
  /** Copy for the user, or null when the outcome needs none. */
  error: string | null
}

export function structuredAgentSessionSendDelivery(
  result: StructuredAgentSessionMutationCallResult<AgentSessionSendResult>,
  retained = false
): StructuredAgentSessionSendDelivery {
  if (result.status === 'unknown') {
    return { outcome: 'unknown', operationIdSpent: false, error: null }
  }
  if (result.status === 'refused') {
    const refusalState = agentSessionRefusalOperationState(result.code)
    if (refusalState === 'unknown') {
      return { outcome: 'unknown', operationIdSpent: false, error: null }
    }
    return {
      outcome: 'rejected',
      operationIdSpent: refusalState === 'settled-rejected' && !retained,
      error: result.message
    }
  }
  if (result.status !== 'accepted') {
    return {
      outcome: 'rejected',
      operationIdSpent: !retained || result.hostRejectedByRequestSchema === true,
      error: result.message
    }
  }
  if ('queued' in result.value && result.value.queued) {
    // The host holds (or already settled) the draft: the send is spent — a
    // later identical message is a new message. A withdrawn replay is spent
    // too, never unknown: its card was deleted or carried by a /clear, and the
    // caller resends it or hands the text back. A dispatched draft answers here
    // only when the host could not find the submission it became (a live one
    // answers with that submission), so no echo would retire an optimistic
    // bubble: it shows nothing, and the transcript or the card owns the text.
    return { outcome: 'queued', operationIdSpent: true, error: null }
  }
  const submission: AgentJournalSubmission | undefined =
    'submission' in result.value ? result.value.submission : undefined
  if (submission !== undefined && submission.queuedMessageId === result.value.clientMessageId) {
    // The host says this id's queued draft was handed off as that submission: the send reached
    // it, so the id is spent now, not when a stream that may never carry the hand-off shows it.
    // Which send the client meant stays unconfirmed, as for any retained replay of a live send.
    return { outcome: 'unknown', operationIdSpent: true, error: null }
  }
  if (!submission || submission.dispatchState === 'unknown') {
    return { outcome: 'unknown', operationIdSpent: false, error: null }
  }
  if (submission.dispatchState === 'rejected') {
    return {
      outcome: 'rejected',
      operationIdSpent: true,
      error: structuredAgentSessionRejectionNotice(submission.reason, 'composer-send')
    }
  }
  if (retained) {
    // A payload match cannot distinguish retrying the ambiguous action from a
    // later identical intent. Wait for the stream to settle and release it.
    return { outcome: 'unknown', operationIdSpent: false, error: null }
  }
  return { outcome: 'accepted', operationIdSpent: true, error: null }
}

export type StructuredAgentSessionSendIntentAttachment = StructuredAgentSessionAttachment & {
  contentFingerprint?: string
}

// The `mobile.*` domains are part of keys the phone has already saved; renaming them orphans
// every retained id.
export function structuredAgentSessionSendOperationKey(input: {
  sessionKey: string
  intentFingerprint: string
}): string {
  return structuredAgentSessionDomainFingerprint({
    domain: 'mobile.agentSession.send.operation',
    sessionId: input.sessionKey,
    fields: { intentFingerprint: input.intentFingerprint }
  })
}

/** The key a retained send id is saved under: the session, the trimmed text and each
 *  attachment's fingerprint, plus `delivery` when the send asks to queue. */
export function structuredAgentSessionSendIntentKey(input: {
  sessionKey: string
  text: string
  attachments: readonly StructuredAgentSessionSendIntentAttachment[]
  delivery?: 'queue-if-active'
}): string {
  const intentFields = {
    text: input.text.trimEnd(),
    attachments: input.attachments.map(
      (attachment) =>
        attachment.contentFingerprint ??
        structuredAgentSessionDomainFingerprint({
          domain: 'mobile.nativeChat.image.preview',
          sessionId: '',
          fields: { previewUri: attachment.previewUri }
        })
    )
  }
  // `delivery` is part of the intent key, never a stored journal field: the
  // immediate key is exactly today's, so an older build still reads the journal.
  return structuredAgentSessionSendOperationKey({
    sessionKey: input.sessionKey,
    intentFingerprint: structuredAgentSessionDomainFingerprint({
      domain: 'mobile.agentSession.send.intent',
      sessionId: input.sessionKey,
      fields: input.delivery ? { ...intentFields, delivery: input.delivery } : intentFields
    })
  })
}
