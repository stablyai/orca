import type { AgentSessionFailureFact } from './agent-session-failure'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalMessageItem } from './agent-session-journal-types'
import {
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import {
  agentSessionOwnerVerdictAllowsFreshOperationId,
  agentSessionRefusalOperationState
} from './agent-session-refusal-retry'
import {
  structuredAgentSessionMessageSendMutation,
  type StructuredAgentSessionSendMutation
} from './structured-agent-session-send-mutation'
import { parseStructuredAgentSessionOutboxQueueFields } from './structured-agent-session-outbox-delivery'

/** `rejected`: settled as not delivered. The drain never sends it again and nothing queues behind
 *  it. One the host refused unrecorded waits for the user's Retry. One it recorded owes no delivery
 *  and leaves on the batch or page that loads its row (`structured-agent-session-outbox-reconcile`). */
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
   *  is sent again or delivered, instead of outliving it as a separate error. On a `queued` entry
   *  it is also the hold (structured-agent-session-outbox-admission). */
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

/** The host forgot this message's id, a day after it was made, and refuses it for good: only a new
 *  id sends it. The id was kept because an earlier attempt under it may already be in the chat; a
 *  first attempt's was replaced when it was refused. */
export function structuredAgentSessionEntryIdExpired(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return (
    entry.state === 'queued' &&
    entry.lastFailure?.kind === 'refused' &&
    entry.lastFailure.code === 'agent_session_operation_expired'
  )
}

/** The host recorded this send and then rejected it: no Retry, since sending it again is a new
 *  message. The reconcile drops it once the client holds the rejected submission. */
export function structuredAgentSessionEntryRejectedByHost(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return entry.state === 'rejected' && entry.lastFailure?.kind === 'rejected'
}

export function requeueStructuredAgentSessionSendRefusal(
  entry: StructuredAgentSessionOutboxEntry,
  refusal: AgentSessionWriteRefusal,
  createOperationId: () => string,
  retainOperationId = false
): StructuredAgentSessionOutboxEntry {
  const refusalSettled = agentSessionRefusalOperationState(refusal.code) === 'settled-rejected'
  // An exited owner runs nothing under the old id, so a new one can't collide; the message still
  // waits for its Retry, since nothing recorded it.
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
  // doubt, may have landed, so those keep it. Only a settled refusal proves the message never
  // landed.
  return {
    ...entry,
    clientMessageId: createOperationId(),
    state: refusalSettled ? 'rejected' : 'queued',
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
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

/** The `agentSession.send` arguments an entry stands for. */
export function structuredAgentSessionSendMutation(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): StructuredAgentSessionSendMutation {
  return structuredAgentSessionMessageSendMutation({
    sessionId: entry.sessionId,
    clientOperationId: entry.clientMessageId,
    expectedRuntimeFence,
    body: entry.body,
    delivery: entry.sentDelivery ?? undefined
  })
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
