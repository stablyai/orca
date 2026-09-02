import type { AgentJournalMessageItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'
import type { AgentSessionWireRefusalCode } from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

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
  createOperationId: () => string
): StructuredAgentSessionOutboxEntry {
  if (agentSessionRefusalOperationState('agentSession.send', code) !== 'settled-rejected') {
    return { ...entry, state: 'queued' }
  }
  return {
    ...entry,
    clientMessageId: createOperationId(),
    state: 'queued',
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
      submission?.dispatchState === 'unknown' &&
      entry.retryAfterUnknownSubmittedAt !== -1 &&
      entry.retryAfterUnknownSubmittedAt !== submission.submittedAt
    ) {
      return [{ ...entry, state: 'unconfirmed' as const }]
    }
    return [entry]
  })
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
        : null
  }
}

export function structuredAgentSessionSendRequest(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): Record<string, unknown> {
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
    ...(entry.retryAfterUnknownSubmittedAt !== null ? { retryUnknown: true } : {}),
    ...fields
  }
}

export type StructuredAgentSessionSendFailure = 'delivery-unknown' | 'failed'

export function classifyStructuredAgentSessionSendFailure(
  error: unknown,
  isDeliveryUnknown: (error: unknown) => boolean
): StructuredAgentSessionSendFailure {
  return isDeliveryUnknown(error) ? 'delivery-unknown' : 'failed'
}
