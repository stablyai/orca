import { createAgentSessionSettledBodyReader } from '../../../shared/agent-session-settled-body-reader'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  type AgentSessionSettledBodyRead
} from '../../../shared/agent-session-settled-body-wire'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { structuredAgentSessionHostSupports } from './structured-agent-session-client'
import { callRuntimeRpc } from './runtime-rpc-client'

export async function readStructuredAgentSessionSettledBody(
  target: RuntimeClientTarget,
  request: AgentSessionSettledBodyRead
): Promise<unknown> {
  if (!(await structuredAgentSessionHostSupports(target, AGENT_SESSION_SETTLED_BODY_CAPABILITY))) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const { sessionId, itemId, ...bodySource } = request
  return callRuntimeRpc(
    target,
    'agentSession.item',
    { sessionId, itemId, bodySource },
    { timeoutMs: 30_000 }
  )
}

export function createNativeChatSettledBodyReader(target: RuntimeClientTarget | null) {
  return createAgentSessionSettledBodyReader((request) =>
    target
      ? readStructuredAgentSessionSettledBody(target, request)
      : Promise.reject(new Error('Chat is unavailable'))
  )
}
