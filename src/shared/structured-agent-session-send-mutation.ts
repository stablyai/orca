import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

export type StructuredAgentSessionSendMutation = {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  delivery?: 'queue-if-active'
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
  const fields = { body: message.body, ...(message.delivery ? { delivery: message.delivery } : {}) }
  return {
    envelope: {
      sessionId: message.sessionId,
      clientOperationId: message.clientOperationId,
      expectedRuntimeFence: message.expectedRuntimeFence,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: message.sessionId,
        fields
      })
    },
    ...fields
  }
}
