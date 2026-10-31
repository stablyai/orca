import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callStructuredAgentSession } from './structured-agent-session-client'

export async function closeStructuredAgentSession(
  target: RuntimeClientTarget,
  sessionId: string,
  beforeSend?: () => void
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
  await (beforeSend
    ? callStructuredAgentSession(target, 'agentSession.close', { sessionId }, { beforeSend })
    : callStructuredAgentSession(target, 'agentSession.close', { sessionId }))
  return 'closed'
}
