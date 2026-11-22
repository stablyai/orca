import { parseExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import { getOrcadSshDeployment } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { workspaceOwnerHostId } from '@/lib/workspace/ownership/workspace-row-owner-host'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'

/** Expose terminal-owned SSH-managed server refusal when automatic re-pairing failed or its host now serves another server; no retry remains. */
export function selectManagedPairingRefusedEnvironmentId(
  state: AppState,
  statuses: RuntimeStatuses,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const host = parseExecutionHostId(workspaceOwnerHostId(state, worktreeId))
  if (host?.kind !== 'runtime') {
    return null
  }
  const environment = state.runtimeEnvironments.find((entry) => entry.id === host.environmentId)
  if (!environment || !getOrcadSshDeployment(environment)) {
    return null
  }
  const snapshot = statuses.get(environment.id)?.snapshot
  return snapshot?.verification === 'blocked' &&
    !snapshot.retired &&
    (snapshot.blockedReason === 'access-revoked' || snapshot.blockedReason === 'server-replaced')
    ? environment.id
    : null
}

/** The host now serves another server: only Forget and a fresh Connect can pair again. */
export function selectManagedServerReplaced(
  statuses: RuntimeStatuses,
  environmentId: string | null
): boolean {
  return environmentId
    ? statuses.get(environmentId)?.snapshot?.blockedReason === 'server-replaced'
    : false
}

export function useManagedPairingRefusedEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStoreWithHostStatuses((state, statuses) =>
    selectManagedPairingRefusedEnvironmentId(state, statuses, worktreeId)
  )
}

export function useManagedServerReplaced(environmentId: string | null): boolean {
  return useAppStoreWithHostStatuses((_state, statuses) =>
    selectManagedServerReplaced(statuses, environmentId)
  )
}
