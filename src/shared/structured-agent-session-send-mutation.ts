import type { AgentJournalItemBody, AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import type { z } from 'zod'
import type { SendBody } from './rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

/** What a send carries beside its message: both join the OPERATION fingerprint, never the body's. */
export type StructuredAgentSessionSendControl = {
  delivery?: 'queue-if-active'
  options?: Readonly<Record<string, string>>
  usageLimitContinuationOfTurnItemId?: string
}

export type StructuredAgentSessionSendMutation = StructuredAgentSessionSendControl & {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
}

/** The control fields a send names, as the client sends them and the host digests them. */
export function agentSessionSendControlFields(
  send: StructuredAgentSessionSendControl
): StructuredAgentSessionSendControl {
  return {
    ...(send.delivery ? { delivery: send.delivery } : {}),
    ...(send.options ? { options: send.options } : {}),
    ...(send.usageLimitContinuationOfTurnItemId
      ? { usageLimitContinuationOfTurnItemId: send.usageLimitContinuationOfTurnItemId }
      : {})
  }
}

/** What a send's operation fingerprint covers, on the client and the host alike. */
export function agentSessionSendFields(
  send: StructuredAgentSessionSendControl & { body: AgentJournalMessageItem }
): StructuredAgentSessionSendControl & { body: AgentJournalMessageItem } {
  return { body: agentSessionMessagePayload(send.body), ...agentSessionSendControlFields(send) }
}

/** What every send fingerprint covers: the message without its sender, which never reaches the
 *  provider, so its echo still matches. A body with no sender hashes exactly as it always has. */
export function agentSessionMessagePayload(body: AgentJournalMessageItem): AgentJournalMessageItem {
  const { from: _sender, ...payload } = body
  return payload
}

/** The body-only hash a submission and a queued draft store, and a provider echo is matched by. */
export function agentSessionSendBodyFingerprint(
  sessionId: string,
  body: AgentJournalItemBody
): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: body.kind === 'message' ? agentSessionMessagePayload(body) : body }
  })
}

/** The `agentSession.send` arguments for one message. Typed rather than wire-shaped so a host
 *  calling its own send path builds the same envelope a client would, fingerprint included. */
export function structuredAgentSessionMessageSendMutation(
  message: {
    sessionId: string
    clientOperationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
  } & StructuredAgentSessionSendControl
): StructuredAgentSessionSendMutation {
  const control = agentSessionSendControlFields(message)
  return {
    envelope: {
      sessionId: message.sessionId,
      clientOperationId: message.clientOperationId,
      expectedRuntimeFence: message.expectedRuntimeFence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: message.sessionId,
        fields: agentSessionSendFields(message)
      })
    },
    body: message.body,
    ...control
  }
}

export type StructuredAgentSessionAttachment = {
  path: string
  previewUri: string
  /** The SSH connection a remote image lives on; kept by the client, never sent. */
  connectionId?: string
}

/** The journal body for a message a person sends: its text, then its images. */
export function structuredAgentSessionSendBody(
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[]
): z.infer<typeof SendBody> {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      ...(text.trim().length > 0 ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...attachments.map((attachment) => ({ type: 'image-ref' as const, path: attachment.path }))
    ]
  }
}
