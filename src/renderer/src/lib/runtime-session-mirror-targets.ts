import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { getRuntimeSessionMirrorEnvironmentIds } from './runtime-session-mirror-owners'

type RuntimeMirrorStatus = {
  status: { runtimeId: string } | null
  connectionGeneration?: number
}

type RuntimeMirrorEnvironment = {
  id: string
  createdAt: number
  pairingRevision?: number
}

export type RuntimeSessionMirrorTarget = {
  environmentId: string
  runtimeId: string
  connectionGeneration: number
  pairingRevision: number
}

export type RuntimeSessionMirrorTargetState = Omit<
  WorktreeRuntimeOwnerState,
  'runtimeEnvironments'
> & {
  runtimeEnvironments?: readonly RuntimeMirrorEnvironment[]
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, RuntimeMirrorStatus>
}

export function getReachableRuntimeSessionMirrorTargets(
  state: RuntimeSessionMirrorTargetState
): RuntimeSessionMirrorTarget[] {
  const environmentById = new Map(
    (state.runtimeEnvironments ?? []).map((environment) => [environment.id, environment])
  )
  const targets: RuntimeSessionMirrorTarget[] = []
  for (const environmentId of getRuntimeSessionMirrorEnvironmentIds(state)) {
    const status = state.runtimeStatusByEnvironmentId?.get(environmentId)
    if (!status?.status) {
      continue
    }
    const environment = environmentById.get(environmentId)
    if (!environment) {
      continue
    }
    targets.push({
      environmentId,
      runtimeId: status.status.runtimeId,
      connectionGeneration: status.connectionGeneration ?? 0,
      pairingRevision: environment.pairingRevision ?? environment.createdAt
    })
  }
  return targets
}
