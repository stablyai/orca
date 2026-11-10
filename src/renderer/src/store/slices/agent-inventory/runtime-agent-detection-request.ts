import { getRuntimeEnvironmentStatus } from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/preflight-runtime-capabilities'

export class RuntimeAgentDetectionNeedsServerUpdateError extends Error {
  constructor() {
    super("Update Orca on this server to list this workspace's agents.")
    this.name = 'RuntimeAgentDetectionNeedsServerUpdateError'
  }
}

/** A paired host's workspace that lives on one of that host's own SSH targets. */
export type NestedSshAgentDetection<T> = {
  connectionId: string
  call: (params: { connectionId: string }) => Promise<T>
}

/** Old hosts can supply workspace agents via host defaults only on known non-Windows platforms; host-default requests remain synchronous. */
// Every caller is a launch inventory: ask the host to skip probing agents disabled in its Settings (#40636).
export function callRuntimeAgentDetection<T>(
  environmentId: string,
  worktreeId: string | null | undefined,
  call: (params: { worktreeId?: string; enabledOnly: boolean }) => Promise<T>,
  nestedSsh?: NestedSshAgentDetection<T>
): Promise<T> {
  if (!worktreeId) {
    return call({ enabledOnly: true })
  }
  const capability = PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY
  return runtimeEnvironmentSupportsCapability(environmentId, capability).then(async (supported) => {
    if (supported) {
      return call({ worktreeId, enabledOnly: true })
    }
    // Why: a fresh status both reports the platform and catches an in-place upgrade.
    const status = await getRuntimeEnvironmentStatus(environmentId)
    if (status.capabilities?.includes(capability)) {
      return call({ worktreeId, enabledOnly: true })
    }
    // Why: the host's SSH workspace runs on its SSH target, which old hosts already probe by id.
    if (nestedSsh) {
      return nestedSsh.call({ connectionId: nestedSsh.connectionId })
    }
    // Why: an old Windows host's default omits a WSL workspace's agents; an absent platform may be one.
    if (!status.hostPlatform || status.hostPlatform === 'win32') {
      throw new RuntimeAgentDetectionNeedsServerUpdateError()
    }
    return call({ enabledOnly: true })
  })
}
