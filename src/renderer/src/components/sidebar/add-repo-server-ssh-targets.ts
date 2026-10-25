import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import type { SshEditableTarget } from '../../../../shared/ssh-target-management'
import { listRuntimeEditableSshTargets } from '@/runtime/runtime-ssh-target-management'

export type RemoteRepoTarget = SshTarget & { state?: SshConnectionState }

function toRemoteRepoTarget(target: SshEditableTarget): RemoteRepoTarget {
  const {
    connectionStatus,
    connected: _connected,
    remotePlatform: _remotePlatform,
    managedServer: _managedServer,
    ...rest
  } = target
  return {
    ...rest,
    // Why no state when absent: the server has none for it, which is not "disconnected" proof.
    ...(connectionStatus
      ? {
          state: { targetId: target.id, status: connectionStatus, error: null, reconnectAttempt: 0 }
        }
      : {})
  }
}

/** The SSH hosts a paired server owns, for its Add Project flow. */
export async function loadServerSshTargets(environmentId: string): Promise<RemoteRepoTarget[]> {
  return (await listRuntimeEditableSshTargets(environmentId)).map(toRemoteRepoTarget)
}

/** Overlays the server's pushed SSH states (mirrored in the store) onto the listed targets. */
export function withServerSshStates(
  targets: RemoteRepoTarget[],
  states: ReadonlyMap<string, SshConnectionState> | undefined
): RemoteRepoTarget[] {
  if (!states) {
    return targets
  }
  let changed = false
  const next = targets.map((target) => {
    const state = states.get(target.id)
    if (!state || state === target.state) {
      return target
    }
    changed = true
    return { ...target, state }
  })
  return changed ? next : targets
}
