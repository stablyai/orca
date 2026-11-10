import { MULTI_REPO_WORKSPACE_RUNTIME_CAPABILITY } from '../../../../../shared/worktree-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { runtimeEnvironmentSupportsCapability } from '../../../runtime/rpc/compatibility/runtime-capability-proof'

/** Local hosts always ship the feature; remote hosts must advertise it. */
export async function multiRepoWorkspaceSupportedOnTarget(
  target: RuntimeClientTarget
): Promise<boolean> {
  if (target.kind === 'local') {
    return true
  }
  return runtimeEnvironmentSupportsCapability(
    target.environmentId,
    MULTI_REPO_WORKSPACE_RUNTIME_CAPABILITY
  )
}
