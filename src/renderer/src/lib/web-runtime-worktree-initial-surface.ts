import { AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import { hostSnapshotAffirmsAgentSessions } from '@/runtime/host-session-snapshot-authority'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'

/** The host's current inventory, rather than its terminal count, authorizes an automatic seed. */
export async function canSeedWebRuntimeWorktreeInitialSurface(
  environmentId: string,
  worktreeId: string
): Promise<boolean> {
  if (
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY
    ))
  ) {
    return true
  }
  let empty = false
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
    errorMode: 'throw',
    onCurrentSnapshot: (snapshot) => {
      empty =
        !snapshot.initialSurfaceLaunch &&
        hostSnapshotAffirmsAgentSessions(snapshot) &&
        snapshot.tabs.length === 0
    }
  })
  return empty
}
