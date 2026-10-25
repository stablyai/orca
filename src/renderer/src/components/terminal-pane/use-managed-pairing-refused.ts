import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getOrcadSshDeployment } from '../../../../shared/runtime-environments'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

/**
 * The server managed over SSH that owns this workspace when it refuses this desktop and pairing
 * again over SSH failed; null otherwise. Nothing retries then, so the pane says so.
 */
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
    snapshot.blockedReason === 'access-revoked'
    ? environment.id
    : null
}

export function useManagedPairingRefusedEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStore((state) => selectManagedPairingRefusedEnvironmentId(state, worktreeId))
}
