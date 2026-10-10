import {
  getRuntimeEnvironmentStatus,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

export class RuntimeAgentDetectionNeedsServerUpdateError extends Error {
  constructor() {
    super("Update Orca on this server to list this workspace's agents.")
    this.name = 'RuntimeAgentDetectionNeedsServerUpdateError'
  }
}

/**
 * Sends `preflight.detectAgents` / `refreshAgents` scoped to a workspace. A host without the
 * workspace-scoped capability can only answer its own default, which is the workspace's list only
 * on a known non-Windows host. The host default goes out synchronously, as it always has.
 */
export function callRuntimeAgentDetection<T>(
  environmentId: string,
  worktreeId: string | null | undefined,
  call: (params: { worktreeId: string } | undefined) => Promise<T>
): Promise<T> {
  if (!worktreeId) {
    return call(undefined)
  }
  const capability = PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY
  return runtimeEnvironmentSupportsCapability(environmentId, capability).then(async (supported) => {
    if (supported) {
      return call({ worktreeId })
    }
    // Why: a fresh status both reports the platform and catches an in-place upgrade.
    const status = await getRuntimeEnvironmentStatus(environmentId)
    if (status.capabilities?.includes(capability)) {
      return call({ worktreeId })
    }
    // Why: an old Windows host's default omits a WSL workspace's agents; an absent platform may be one.
    if (!status.hostPlatform || status.hostPlatform === 'win32') {
      throw new RuntimeAgentDetectionNeedsServerUpdateError()
    }
    return call(undefined)
  })
}
