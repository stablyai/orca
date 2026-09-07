import type { AgentSessionHandleProvider } from './agent-session-provider-handle'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from './structured-agent-session-mutation'

export type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: AgentSessionHandleProvider
}

/** Provider-prefixed so a session id names its lane on sight, and underscore-only
 *  so the id stays a single token everywhere it is embedded (tab ids, log keys). */
export function createStructuredAgentSessionId(
  agent: AgentSessionHandleProvider,
  randomUuid: () => string
): string {
  return `${agent}_${randomUuid().replaceAll('-', '_')}`
}

/**
 * The durable `agentSession.create` envelope every client replays on an ambiguous
 * transport failure. The fingerprint must be computed over the same fields the host
 * recomputes, so both clients build it here rather than each assembling their own.
 */
export function structuredAgentSessionCreateParams(args: {
  sessionId: string
  worktree: string
  agent: AgentSessionHandleProvider
  randomUuid: () => string
  now?: number
}): StructuredAgentSessionCreateParams {
  const fields = { worktree: args.worktree, agent: args.agent }
  return {
    envelope: {
      sessionId: args.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(args.randomUuid, args.now),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: args.sessionId,
        ...fields
      })
    },
    ...fields
  }
}
