import type { AgentSessionFailureFact } from './agent-session-failure'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalMessageItem, AgentJournalSubmission } from './agent-session-journal-types'
import {
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import {
  agentSessionOwnerVerdictAllowsFreshOperationId,
  agentSessionRefusalOperationState
} from './agent-session-refusal-retry'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import { parseStructuredAgentSessionOutboxQueueFields } from './structured-agent-session-outbox-delivery'

/** `rejected`: the host settled the send as not delivered. The drain never sends it again on its
 *  own and nothing queues behind it; only the user's Retry does. */
export type StructuredAgentSessionOutboxState =
  | 'queued'
  | 'dispatching'
  | 'unconfirmed'
  | 'rejected'

export type StructuredAgentSessionOutboxEntry = {
  clientMessageId: string
  sessionId: string
  body: AgentJournalMessageItem
  previewUris: string[]
  state: StructuredAgentSessionOutboxState
  queuedAt: number
  lastAttemptAt: number | null
  retryAfterUnknownSubmittedAt: number | null
  source?: 'launch'
  /** A Stop landed after this queue send went out: only the user's Retry sends it again, never the
   *  drain, the unconfirmed probe or an owner change, which would start a turn the user stopped. */
  outlivedStop?: true
  /** Whether the first attempt asked the host to hold it as a draft (`null`: plain); every replay
   *  of this id asks the same (structured-agent-session-outbox-delivery). On a request's own copy,
   *  what that request carries. */
  sentDelivery?: 'queue-if-active' | null
  /** Why the last attempt did not go through. Lives on the message so it goes when the message
   *  is sent again or delivered, instead of outliving it as a separate error. */
  lastFailure?: StructuredAgentSessionAttemptFailure
}

/** A host's rejection fact as a message keeps it: never its provider detail, whose log text is not
 *  kept client-side, or its refusal. The journal row keeps the whole fact, and words the notice
 *  while it is loaded; this copy words it when it is not. */
export type StructuredAgentSessionRejectionFact = Pick<
  AgentSessionFailureFact,
  'kind' | 'attachment'
>

/** Kept as the fact, not the words: the Retry row chooses those when it shows the entry. */
export type StructuredAgentSessionAttemptFailure =
  | AgentSessionWriteFailure
  /** The host recorded the message and the provider turned it down, with the provider's reason. */
  | { kind: 'rejected'; reason: string | null; rejection?: StructuredAgentSessionRejectionFact }

/** The failure a rejected submission leaves on its message. A fact this build cannot read whole is
 *  dropped, leaving the reason. */
export function structuredAgentSessionRejectedFailure(submission: {
  reason: string | null
  rejection?: unknown
}): Extract<StructuredAgentSessionAttemptFailure, { kind: 'rejected' }> {
  const fact = readWholeAgentSessionFailureFact(submission.rejection)
  return {
    kind: 'rejected',
    reason: submission.reason,
    ...(fact
      ? {
          rejection: {
            kind: fact.kind,
            ...(fact.attachment ? { attachment: fact.attachment } : {})
          }
        }
      : {})
  }
}

function parseStructuredAgentSessionAttemptFailure(
  value: unknown
): StructuredAgentSessionAttemptFailure | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'rejected' &&
    'reason' in value
  ) {
    return value.reason === null || typeof value.reason === 'string'
      ? structuredAgentSessionRejectedFailure({
          reason: value.reason,
          rejection: 'rejection' in value ? value.rejection : undefined
        })
      : undefined
  }
  return parseAgentSessionWriteFailure(value)
}

export type StructuredAgentSessionAttachment = {
  path: string
  previewUri: string
}

export function structuredAgentSessionSendBody(
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[]
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      ...(text.trim().length > 0 ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...attachments.map((attachment) => ({ type: 'image-ref' as const, path: attachment.path }))
    ]
  }
}

export function createStructuredAgentSessionOutboxEntry(args: {
  clientMessageId: string
  sessionId: string
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
  queuedAt: number
}): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId: args.clientMessageId,
    sessionId: args.sessionId,
    body: structuredAgentSessionSendBody(args.text, args.attachments),
    previewUris: args.attachments.map((attachment) => attachment.previewUri),
    state: 'queued',
    queuedAt: args.queuedAt,
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
}

export function updateStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  id: string,
  update: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry | null
): StructuredAgentSessionOutboxEntry[] {
  return entries.flatMap((entry) => {
    if (entry.clientMessageId !== id) {
      return [entry]
    }
    const next = update(entry)
    return next ? [next] : []
  })
}

/** Staged for another attempt; the last attempt's failure no longer describes it. */
export function stageStructuredAgentSessionOutboxEntryForSend(
  { lastFailure: _sentAgain, ...entry }: StructuredAgentSessionOutboxEntry,
  now: number
): StructuredAgentSessionOutboxEntry {
  return { ...entry, state: 'dispatching', lastAttemptAt: now }
}

export function requeueStructuredAgentSessionSendRefusal(
  entry: StructuredAgentSessionOutboxEntry,
  refusal: AgentSessionWriteRefusal,
  createOperationId: () => string,
  retainOperationId = false
): StructuredAgentSessionOutboxEntry {
  const refusalSettled = agentSessionRefusalOperationState(refusal.code) === 'settled-rejected'
  // An exited owner runs nothing under the old id, so a new one can't collide; the message still
  // holds the head, since nothing recorded it.
  const ownerExited =
    refusal.code === 'agent_session_ownership_unknown' &&
    agentSessionOwnerVerdictAllowsFreshOperationId(refusal.details?.ownerVerdict)
  if (
    !(refusalSettled || ownerExited) ||
    retainOperationId ||
    entry.state === 'unconfirmed' ||
    entry.retryAfterUnknownSubmittedAt !== null
  ) {
    return { ...entry, state: 'queued' }
  }
  // Only here may the id rotate: an earlier attempt under this id, or one whose delivery was in
  // doubt, may have landed, so those stay queued behind the block. Only a settled refusal proves
  // the message never landed and so releases the queue.
  return {
    ...entry,
    clientMessageId: createOperationId(),
    state: refusalSettled ? 'rejected' : 'queued',
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
}

export function reconcileStructuredAgentSessionOutbox(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionOutboxEntry[] {
  const settled = new Map(submissions.map((entry) => [entry.clientMessageId, entry]))
  return entries.flatMap((entry) => {
    const submission = settled.get(entry.clientMessageId)
    if (submission?.dispatchState === 'accepted') {
      return []
    }
    if (
      submission?.dispatchState === 'rejected' &&
      classifyDispatchRejection(submission).category === 'withdrawn'
    ) {
      return []
    }
    if (submission?.dispatchState === 'pending') {
      return entry.state === 'dispatching' ? [entry] : [{ ...entry, state: 'dispatching' as const }]
    }
    // Accepted, then not delivered — the agent never started, or its start was refused. The text
    // and why stay here for the user's Retry, and nothing queues behind it. `unconfirmed` is how a
    // remount reads an entry it left dispatching; the journal has since answered it.
    if (
      submission?.dispatchState === 'rejected' &&
      (entry.state === 'dispatching' || entry.state === 'unconfirmed')
    ) {
      return [
        {
          ...entry,
          state: 'rejected' as const,
          lastFailure: structuredAgentSessionRejectedFailure(submission)
        }
      ]
    }
    if (
      submission?.dispatchState === 'unknown' &&
      entry.retryAfterUnknownSubmittedAt !== -1 &&
      entry.retryAfterUnknownSubmittedAt !== submission.submittedAt
    ) {
      return [{ ...entry, state: 'unconfirmed' as const }]
    }
    return [entry]
  })
}

export type StructuredAgentSessionOutboxAdmission =
  | { state: 'dispatch'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'blocked'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'idle'; entry: null }

/**
 * What the queue does next. The drain and the Retry affordance both read it, so neither can
 * disagree with the other about which entry is holding the queue.
 *
 * A `dispatching` entry is not a barrier: the host appended its journal row inside the
 * per-session serialize chain before dispatching, so nothing behind it can overtake it, and
 * waiting for its echo costs delivery of everything queued behind it. An `unconfirmed` entry,
 * or one the user must act on, is a barrier — sending past either would reorder around a
 * message that may yet land.
 */
export function admitStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  blockedClientMessageId: string | null
): StructuredAgentSessionOutboxAdmission {
  for (const entry of entries) {
    // It can no longer land, so nothing it could be reordered around; it waits for Retry.
    if (entry.state === 'rejected') {
      continue
    }
    if (entry.state === 'unconfirmed' || entry.clientMessageId === blockedClientMessageId) {
      return { state: 'blocked', entry }
    }
    // A queue send a Stop outlived goes again only on the user's Retry.
    if (entry.state === 'queued') {
      return { state: entry.outlivedStop === true ? 'blocked' : 'dispatch', entry }
    }
  }
  return { state: 'idle', entry: null }
}

export function parseStructuredAgentSessionOutboxEntry(
  value: unknown,
  sessionId: string
): StructuredAgentSessionOutboxEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as Partial<StructuredAgentSessionOutboxEntry>
  const body = entry.body
  if (
    entry.sessionId !== sessionId ||
    typeof entry.clientMessageId !== 'string' ||
    typeof entry.queuedAt !== 'number' ||
    !body ||
    body.kind !== 'message' ||
    body.role !== 'user' ||
    !Array.isArray(body.blocks) ||
    !Array.isArray(entry.previewUris) ||
    !entry.previewUris.every((uri) => typeof uri === 'string') ||
    !['queued', 'dispatching', 'unconfirmed', 'rejected'].includes(entry.state ?? '')
  ) {
    return null
  }
  // A malformed failure is dropped: the row then says only that the message was not sent.
  const lastFailure = parseStructuredAgentSessionAttemptFailure(entry.lastFailure)
  return {
    clientMessageId: entry.clientMessageId,
    sessionId,
    body,
    previewUris: entry.previewUris,
    state: entry.state as StructuredAgentSessionOutboxState,
    queuedAt: entry.queuedAt,
    lastAttemptAt: typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null,
    retryAfterUnknownSubmittedAt:
      typeof entry.retryAfterUnknownSubmittedAt === 'number'
        ? entry.retryAfterUnknownSubmittedAt
        : null,
    ...(entry.source === 'launch' ? { source: 'launch' as const } : {}),
    ...parseStructuredAgentSessionOutboxQueueFields(entry),
    ...(lastFailure ? { lastFailure } : {})
  }
}

export type StructuredAgentSessionSendMutation = {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  delivery?: 'queue-if-active'
}

/** The `agentSession.send` arguments an entry stands for. Typed rather than wire-shaped so a host
 *  calling its own send path builds the same envelope a client would, fingerprint included. */
export function structuredAgentSessionSendMutation(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): StructuredAgentSessionSendMutation {
  // `delivery` joins the OPERATION fingerprint exactly as the host digests it; never the body's.
  const delivery = entry.sentDelivery ?? undefined
  const fields = { body: entry.body, ...(delivery ? { delivery } : {}) }
  return {
    envelope: {
      sessionId: entry.sessionId,
      clientOperationId: entry.clientMessageId,
      expectedRuntimeFence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: entry.sessionId,
        fields
      })
    },
    ...fields
  }
}

export function structuredAgentSessionSendRequest(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): Record<string, unknown> {
  return structuredAgentSessionSendMutation(entry, expectedRuntimeFence)
}

export type StructuredAgentSessionSendFailure = 'delivery-unknown' | 'failed'

export function classifyStructuredAgentSessionSendFailure(
  error: unknown,
  isDeliveryUnknown: (error: unknown) => boolean
): StructuredAgentSessionSendFailure {
  return isDeliveryUnknown(error) ? 'delivery-unknown' : 'failed'
}
