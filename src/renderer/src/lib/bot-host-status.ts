// What a bot host says of itself: its computer name and the capabilities its Orca has.
import { useAppStore } from '@/store'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { AppState } from '@/store/types'
import {
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { normalizeMachineName } from '../../../shared/remote-runtime/host-metadata/machine-name'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** A paired server's last verified status; null for this app's own runtime, or before it is known. */
function pairedStatus(
  hostId: ExecutionHostId,
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'> = useAppStore.getState()
): RuntimeStatus | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  const entry = state.runtimeStatusByEnvironmentId?.get(parsed.environmentId)
  return lastVerifiedRuntimeStatus(entry) ?? null
}

export function botHostMachineName(
  hostId: ExecutionHostId,
  state: Pick<AppState, 'runtimeStatusByEnvironmentId' | 'runtimeEnvironments'>
): string | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  const entry = state.runtimeStatusByEnvironmentId?.get(parsed.environmentId)
  const environment = state.runtimeEnvironments?.find((item) => item.id === parsed.environmentId)
  if (
    !environment ||
    isRuntimeHostContactRevoked(entry) ||
    (entry?.snapshot &&
      (entry.snapshot.verification !== 'verified' ||
        entry.snapshot.pairingRevision !== (environment.pairingRevision ?? environment.createdAt)))
  ) {
    return null
  }
  return normalizeMachineName(entry?.status?.machineName) || null
}

/** The host's own status: this app's runtime asked now, a paired server's as last verified. */
export async function readBotHostStatus(
  hostId: ExecutionHostId
): Promise<Pick<RuntimeStatus, 'machineName' | 'capabilities'> | null> {
  return parseRoutableExecutionHostId(hostId)?.kind === 'local'
    ? window.api.runtime.getStatus()
    : pairedStatus(hostId)
}

/** Whether the host's Orca has `capability`; this app's own runtime is this build, so it does. */
export function botHostHas(
  hostId: ExecutionHostId,
  capability: string,
  state?: Pick<AppState, 'runtimeStatusByEnvironmentId'>
): boolean {
  if (parseRoutableExecutionHostId(hostId)?.kind === 'local') {
    return true
  }
  return pairedStatus(hostId, state)?.capabilities?.includes(capability) === true
}

function runtimeEnvironmentId(hostId: ExecutionHostId): string | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

const selectVerified = (entry: RuntimeEnvironmentStatus | undefined): boolean =>
  lastVerifiedRuntimeStatus(entry) != null

/** Whether the host's status is known: always for this app's runtime, once verified for a server. */
export function useBotHostVerified(hostId: ExecutionHostId): boolean {
  const verified = useRuntimeHostStatusSelector(runtimeEnvironmentId(hostId), selectVerified)
  return parseRoutableExecutionHostId(hostId)?.kind === 'local' || verified
}

/** `botHostHas`, kept current as the server's status changes. */
export function useBotHostHas(hostId: ExecutionHostId, capability: string): boolean {
  const has = useRuntimeHostStatusSelector(
    runtimeEnvironmentId(hostId),
    (entry) => lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(capability) === true
  )
  return parseRoutableExecutionHostId(hostId)?.kind === 'local' || has
}
