// A chat's one send slot: the pending entry that draws a message as sending and keeps any other send
// of that chat out until it settles.

import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../../shared/structured-agent-session-send-mutation'
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
  /** The caller keeps the text if it comes back, instead of the chat's composer. */
  callerKeepsText?: true
  /** Made while the chat read Stopping: drawn after that turn until the host records it. */
  sentWhileStopping?: true
  now?: number
}

/** Takes the chat's one send slot, drawn as sending; null while another send of the chat is out. */
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
    body: structuredAgentSessionSendBody(input.text, attachments),
    previewUris: attachments.map((attachment) => attachment.previewUri),
    queuedAt: input.now ?? Date.now(),
    ...(input.delivery ? { delivery: input.delivery } : {}),
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
