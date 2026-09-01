import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { callStructuredAgentSession } from './structured-agent-session-client'

export async function closeStructuredAgentSession(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<'closed' | 'unsupported'> {
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ))
  ) {
    return 'unsupported'
  }
  await callStructuredAgentSession(target, 'agentSession.close', { sessionId })
  return 'closed'
}
