import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getOrcadSshDeployment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

/** Expose terminal-owned SSH-managed server refusal when automatic re-pairing failed or its host now serves another server; no retry remains. */
export function selectManagedPairingRefusedEnvironmentId(
  state: AppState,
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
  const snapshot = state.runtimeStatusByEnvironmentId.get(environment.id)?.snapshot
  return snapshot?.verification === 'blocked' &&
    !snapshot.retired &&
    (snapshot.blockedReason === 'access-revoked' || snapshot.blockedReason === 'server-replaced')
    ? environment.id
    : null
}

/** The host now serves another server: only Forget and a fresh Connect can pair again. */
export function selectManagedServerReplaced(
  state: AppState,
  environmentId: string | null
): boolean {
  return environmentId
    ? state.runtimeStatusByEnvironmentId.get(environmentId)?.snapshot?.blockedReason ===
        'server-replaced'
    : false
}

export function useManagedPairingRefusedEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStore((state) => selectManagedPairingRefusedEnvironmentId(state, worktreeId))
}

export function useManagedServerReplaced(environmentId: string | null): boolean {
  return useAppStore((state) => selectManagedServerReplaced(state, environmentId))
}
