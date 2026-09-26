import type { AgentJournalMessageItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusalCode
} from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import { DISPATCH_REJECTED_CANCELLED } from './structured-agent-session-dispatch-rejection'

export type StructuredAgentSessionOutboxState = 'queued' | 'dispatching' | 'unconfirmed'

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
  /** Why the last attempt did not go through. Lives on the message so it goes when the message
   *  is sent again or delivered, instead of outliving it as a separate error. */
  notice?: string
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

export function requeueStructuredAgentSessionSendRefusal(
  entry: StructuredAgentSessionOutboxEntry,
  code: AgentSessionWireRefusalCode,
  createOperationId: () => string,
  retainOperationId = false
): StructuredAgentSessionOutboxEntry {
  const refusalState = agentSessionRefusalOperationState(code)
  if (
    refusalState !== 'settled-rejected' ||
    retainOperationId ||
    entry.state === 'unconfirmed' ||
    entry.retryAfterUnknownSubmittedAt !== null
  ) {
    return { ...entry, state: 'queued' }
  }
  return {
    ...entry,
    clientMessageId: createOperationId(),
    state: 'queued',
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
      submission.reason === DISPATCH_REJECTED_CANCELLED
    ) {
      return []
    }
    if (submission?.dispatchState === 'pending') {
      return entry.state === 'dispatching' ? [entry] : [{ ...entry, state: 'dispatching' as const }]
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
    if (entry.state === 'unconfirmed' || entry.clientMessageId === blockedClientMessageId) {
      return { state: 'blocked', entry }
    }
    if (entry.state === 'queued') {
      return { state: 'dispatch', entry }
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
    !['queued', 'dispatching', 'unconfirmed'].includes(entry.state ?? '')
  ) {
    return null
  }
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
    ...(typeof entry.notice === 'string' ? { notice: entry.notice } : {})
  }
}

export type StructuredAgentSessionSendMutation = {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
}

/** The `agentSession.send` arguments an entry stands for. Typed rather than wire-shaped so a host
 *  calling its own send path builds the same envelope a client would, fingerprint included. */
export function structuredAgentSessionSendMutation(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): StructuredAgentSessionSendMutation {
  const fields = { body: entry.body }
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
