import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

/** The provider session an ensureAgentSession call may send to this host; older hosts' strict schema rejects `cwd` and `effort`. */
export async function agentProviderSessionForHostEnsure(
  environmentId: string,
  providerSession: AgentProviderSessionMetadata
): Promise<AgentProviderSessionMetadata> {
  const { cwd: _cwd, effort, ...identity } = providerSession
  return effort && (await hostAcceptsResumeEffort(environmentId))
    ? { ...identity, effort }
    : identity
}

async function hostAcceptsResumeEffort(environmentId: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY
    )
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    return false
  }
}
