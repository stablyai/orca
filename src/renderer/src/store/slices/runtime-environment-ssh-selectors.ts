import type { AppState } from '../types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

type RuntimeAwareSshReadState = Pick<
  AppState,
  | 'sshConnectionStates'
  | 'sshTargetLabels'
  | 'removedSshTargetLabels'
  | 'sshTargetsHydrated'
  | 'sshStateByEnvironment'
> &
  Partial<Pick<AppState, 'runtimeStatusByEnvironmentId'>>

function isEnvironmentReachable(state: RuntimeAwareSshReadState, environmentId: string): boolean {
  return Boolean(state.runtimeStatusByEnvironmentId?.get(environmentId)?.status)
}

export function selectRuntimeAwareSshStatus(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): SshConnectionStatus | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.status ?? 'disconnected'
  }
  if (!isEnvironmentReachable(state, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.status ?? null
}

export function selectRuntimeAwareSshError(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): string | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.error ?? null
  }
  if (!isEnvironmentReachable(state, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.error ?? null
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
  environmentId: string | null,
  targetId: string
): boolean {
  if (environmentId === null) {
    return (
      state.removedSshTargetLabels.has(targetId) ||
      (state.sshTargetsHydrated && !state.sshTargetLabels.has(targetId))
    )
  }
  if (!isEnvironmentReachable(state, environmentId)) {
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
