import type { AgentJournalSkillRef } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionSendOutcome } from './structured-agent-session-send-runtime'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendOut,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

export type StructuredAgentSessionSendInput = {
  sessionId: string
  text: string
  attachments?: readonly StructuredAgentSessionAttachment[]
  /** Asks the host to hold it as a card while the agent works; decided once, at the send. */
  delivery?: 'queue-if-active'
  /** The composer's model and effort for the turn it starts, read once at the send. */
  options?: Readonly<Record<string, string>>
  /** The caller keeps the text if it comes back, instead of the chat's composer. */
  callerKeepsText?: true
  usageLimitContinuationOfTurnItemId?: string
  /** Skills picked from the menu, by file; only to a host that takes them. */
  skills?: readonly AgentJournalSkillRef[]
  /** Made while the chat read Stopping: drawn after that turn until the host records it. */
  sentWhileStopping?: true
  now?: number
}

export type StructuredAgentSessionSendRequest = Pick<
  StructuredAgentSessionSendInput,
  'callerKeepsText' | 'usageLimitContinuationOfTurnItemId' | 'skills'
> & { onSettled?: (outcome: StructuredAgentSessionSendOutcome) => void }

/** Reserve the chat’s single unanswered-send slot; return null while occupied. */
export function takeStructuredAgentSessionSendSlot(
  input: StructuredAgentSessionSendInput
): StructuredAgentSessionPendingSend | null {
  if (structuredAgentSessionSendOut(input.sessionId)) {
    return null
  }
  const attachments = input.attachments ?? []
  const entry: StructuredAgentSessionPendingSend = {
    clientMessageId: createStructuredAgentSessionOperationId(createBrowserUuid),
    sessionId: input.sessionId,
    body: structuredAgentSessionSendBody(input.text, attachments, input.skills),
    previewUris: attachments.map((attachment) => attachment.previewUri),
    queuedAt: input.now ?? Date.now(),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.options ? { options: input.options } : {}),
    ...(input.usageLimitContinuationOfTurnItemId
      ? { usageLimitContinuationOfTurnItemId: input.usageLimitContinuationOfTurnItemId }
      : {}),
    ...(input.callerKeepsText ? { callerKeepsText: true as const } : {}),
    ...(input.sentWhileStopping ? { sentWhileStopping: true as const } : {}),
    ...(attachments.some((attachment) => attachment.connectionId)
      ? { imageConnectionIds: attachments.map((attachment) => attachment.connectionId ?? null) }
      : {}),
    phase: 'sending',
    issued: false
  }
  publishStructuredAgentSessionSends(input.sessionId, {
    entries: [...getStructuredAgentSessionPendingSends(input.sessionId), entry],
    // The notice explains text given back to this chat's composer; only its own sends replace it.
    ...(input.callerKeepsText ? {} : { notice: null })
  })
  return entry
}
