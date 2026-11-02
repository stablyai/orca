import { selectWslHostsServing } from '../sidebar/use-wsl-hosts-enabled'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

export type WslHostUnavailableReason = 'turned-off' | 'server-files-missing'

export function selectWslHostUnavailableReason(
  state: AppState,
  worktreeId: string | null | undefined
): WslHostUnavailableReason | null {
  // Why first: every terminal and explorer subscribes, and most profiles have no WSL host.
  if (!worktreeId || !state.runtimeEnvironments.some(isWslHostRuntimeEnvironment)) {
    return null
  }
  const host = parseExecutionHostId(workspaceOwnerHostId(state, worktreeId))
  const environment =
    host?.kind === 'runtime'
      ? state.runtimeEnvironments.find((candidate) => candidate.id === host.environmentId)
      : undefined
  if (!environment || !isWslHostRuntimeEnvironment(environment)) {
    return null
  }
  return selectWslHostEnvironmentUnavailableReason(state)
}

/** Why any WSL host cannot run now, whichever workspace or host row asks. */
export function selectWslHostEnvironmentUnavailableReason(
  state: Pick<AppState, 'wslHostServerFiles' | 'settings' | 'runtimeEnvironments'>
): WslHostUnavailableReason | null {
  if (state.wslHostServerFiles === 'missing') {
    return 'server-files-missing'
  }
  // A saved host keeps serving with the setting off (it governs new work only), as in serve-only.
  return selectWslHostsServing(state) ? null : 'turned-off'
}

export function useWslHostUnavailableReason(
  worktreeId: string | null | undefined
): WslHostUnavailableReason | null {
  return useAppStore((state) => selectWslHostUnavailableReason(state, worktreeId))
}
