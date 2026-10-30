import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

type DefaultResult = {
  agent: TuiAgent | null
  source: 'project' | 'global' | 'automatic'
  projectId?: string
  projectName?: string
}

/** Resolve against the selected workspace's owner immediately before submission. */
export async function resolveDesktopWorkspaceDefaultAgent(target: {
  repo: string
  hostId?: ExecutionHostId | null
}): Promise<DefaultResult> {
  if (!target.hostId) {
    throw new Error('The target project host is unresolved. Choose a host and retry.')
  }
  const runtimeTarget = runtimeRpcTargetForAuthorityKey(target.hostId)
  if (!runtimeTarget) {
    throw new Error('The target project host cannot be served by this runtime.')
  }
  const supported =
    runtimeTarget.kind === 'local'
      ? (await ensureLocalRuntimeCapabilities())?.includes(
          PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
        ) === true
      : await runtimeEnvironmentSupportsCapability(
          runtimeTarget.environmentId,
          PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
        )
  if (!supported) {
    throw new Error('Update the target Orca host to use project default agents.')
  }
  return callRuntimeRpc<DefaultResult>(runtimeTarget, 'agent.resolveDefault', {
    repo: target.repo,
    repoHostId: target.hostId
  })
}
