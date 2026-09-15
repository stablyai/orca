import {
  lastVerifiedRuntimeStatus,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { getRuntimeSessionMirrorEnvironmentIds } from './runtime-session-mirror-owners'

type RuntimeMirrorStatus = {
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  snapshot?: RuntimeHostStatusSnapshot
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
    const entry = state.runtimeStatusByEnvironmentId?.get(environmentId)
    // Why the shared verdict and not `entry.status`: a still-ready transport whose probe
    // came back unverifiable nulls `entry.status` while the host keeps delivering. Reading
    // that as "gone" tore the mirror down mid-flow, disagreeing with every host surface.
    // Dropping the mirror is destructive, so only the one exit verdict earns it —
    // 'checking' and 'reconnecting' are unverifiable (docs/reference/ssh-execution-boundary.md).
    if (isDisconnectedRuntimeHostState(runtimeHostConnectionStateForEntry(entry))) {
      continue
    }
    const runtimeId = lastVerifiedRuntimeStatus(entry)?.runtimeId
    if (!runtimeId) {
      continue
    }
    const environment = environmentById.get(environmentId)
    if (!environment) {
      continue
    }
    targets.push({
      environmentId,
      runtimeId,
      connectionGeneration: entry?.connectionGeneration ?? 0,
      pairingRevision: environment.pairingRevision ?? environment.createdAt
    })
  }
  return targets
}
