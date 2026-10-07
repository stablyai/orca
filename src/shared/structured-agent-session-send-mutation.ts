import type { AgentJournalItemBody, AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

export type StructuredAgentSessionSendMutation = {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  delivery?: 'queue-if-active'
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
export function structuredAgentSessionMessageSendMutation(message: {
  sessionId: string
  clientOperationId: string
  expectedRuntimeFence: number
  body: AgentJournalMessageItem
  delivery?: 'queue-if-active'
}): StructuredAgentSessionSendMutation {
  // `delivery` joins the OPERATION fingerprint exactly as the host digests it; never the body's.
  const delivery = message.delivery ? { delivery: message.delivery } : {}
  return {
    envelope: {
      sessionId: message.sessionId,
      clientOperationId: message.clientOperationId,
      expectedRuntimeFence: message.expectedRuntimeFence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: message.sessionId,
        fields: { body: agentSessionMessagePayload(message.body), ...delivery }
      })
    },
    body: message.body,
    ...delivery
  }
}
