import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import { AGENT_SESSION_RESTORE_SOURCE_PANE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '../../../rpc/compatibility/runtime-capability-proof'
import { isRuntimeCompatBlockError } from '../../../rpc/compatibility/runtime-protocol-compat'
import { toHostSessionPaneKey } from '../../../../../../shared/workspace-layout/terminal-surface-id'

/** The provider session an ensureAgentSession call may send to this host; older hosts' strict schema rejects `cwd` and `permissionMode`, and older hosts' also `effort`. */
export async function agentProviderSessionForHostEnsure(
  environmentId: string,
  providerSession: AgentProviderSessionMetadata
): Promise<AgentProviderSessionMetadata> {
  const { cwd: _cwd, effort, permissionMode: _permissionMode, ...identity } = providerSession
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

/** The source pane a saved restore names, in the host's own keys, for hosts whose strict schema accepts it. */
export async function restoreSourcePaneOptions(
  environmentId: string,
  paneKey: string
): Promise<{ restoreSourcePaneKey?: string }> {
  try {
    return (await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_RESTORE_SOURCE_PANE_RUNTIME_CAPABILITY
    ))
      ? { restoreSourcePaneKey: toHostSessionPaneKey(paneKey) }
      : {}
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    return {}
  }
}
