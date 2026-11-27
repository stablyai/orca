import type { AppState } from '../../types'
import type { RuntimeStatuses } from '../runtime-status/views/runtime-status-owner'
import type { SshConnectionStatus } from '../../../../../shared/remote-runtime/ssh/ssh-types'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { isConnectedRuntimeHostState } from '../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'

type RuntimeAwareSshReadState = Pick<
  AppState,
  | 'sshConnectionStates'
  | 'sshTargetLabels'
  | 'removedSshTargetLabels'
  | 'sshTargetsHydrated'
  | 'sshStateByEnvironment'
>

/** What a target's status reads; narrower so callers needn't carry the label maps. */
export type RuntimeAwareSshStatusState = Pick<
  AppState,
  'sshConnectionStates' | 'sshStateByEnvironment'
>

// A null probe can leave transport connected; use shared reachability verdict or mirrored targets vanish (ssh-execution-boundary.md).
function isEnvironmentReachable(statuses: RuntimeStatuses, environmentId: string): boolean {
  return isConnectedRuntimeHostState(
    runtimeHostConnectionStateForEntry(statuses.get(environmentId))
  )
}

export function selectRuntimeAwareSshStatus(
  state: RuntimeAwareSshStatusState,
  statuses: RuntimeStatuses,
  environmentId: string | null,
  targetId: string
): SshConnectionStatus | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.status ?? 'disconnected'
  }
  if (!isEnvironmentReachable(statuses, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.status ?? null
}

export function selectRuntimeAwareSshError(
  state: RuntimeAwareSshStatusState,
  statuses: RuntimeStatuses,
  environmentId: string | null,
  targetId: string
): string | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.error ?? null
  }
  if (!isEnvironmentReachable(statuses, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.error ?? null
}

export function selectRuntimeAwareSshConnectionGeneration(
  state: RuntimeAwareSshReadState,
  statuses: RuntimeStatuses,
  environmentId: string | null,
  targetId: string
): number | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.connectionGeneration ?? null
  }
  if (!isEnvironmentReachable(statuses, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.connectionGeneration ?? null
}

export function selectRuntimeAwareSshTargetLabel(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): string {
  if (environmentId === null) {
    return (
      state.sshTargetLabels.get(targetId) ?? state.removedSshTargetLabels.get(targetId) ?? targetId
    )
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  return bucket?.targetLabels.get(targetId) ?? bucket?.removedTargetLabels.get(targetId) ?? targetId
}

export function selectRuntimeAwareSshTargetRemoved(
  state: RuntimeAwareSshReadState,
  statuses: RuntimeStatuses,
  environmentId: string | null,
  targetId: string
): boolean {
  if (environmentId === null) {
    return (
      state.removedSshTargetLabels.has(targetId) ||
      (state.sshTargetsHydrated && !state.sshTargetLabels.has(targetId))
    )
  }
  if (!isEnvironmentReachable(statuses, environmentId)) {
    return false
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket) {
    return false
  }
  return (
    bucket.removedTargetLabels.has(targetId) ||
    (bucket.targetsHydrated && !bucket.targetLabels.has(targetId))
  )
}
