import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { tailscaleHostOfEndpoint } from '../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import type { RemoteRuntimeRecoveryCause } from './remote-runtime-recovery-copy'

/** Read shared server reconnection once so individual panes do not announce the same outage. */
export function selectRetryingOutageEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  if (!environmentId) {
    return null
  }
  // Only reconnecting proves transport loss; checking or failed probes over a live socket do not.
  const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
  return runtimeHostConnectionStateForEntry(entry) === 'reconnecting' ? environmentId : null
}

export function selectWorkspaceRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const host = worktreeId ? parseExecutionHostId(workspaceOwnerHostId(state, worktreeId)) : null
  return host?.kind === 'runtime' ? host.environmentId : null
}

export function selectRemoteServerOutageCause(
  state: AppState,
  environmentId: string
): Extract<RemoteRuntimeRecoveryCause, 'connection-lost' | 'server-restarting'> {
  // Why only the updater: a server stop terminates sockets without a close code, so its own restart is the only evidence.
  return state.remoteServerUpdates.get(environmentId)?.phase === 'restarting'
    ? 'server-restarting'
    : 'connection-lost'
}

export function selectRuntimeServerName(state: AppState, environmentId: string): string {
  return selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environmentId))
}

export function selectRuntimeServerTailscaleHost(
  state: AppState,
  environmentId: string
): string | null {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  const endpoint =
    environment?.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment?.endpoints[0]
  return tailscaleHostOfEndpoint(endpoint?.endpoint)
}

export function useRetryingOutageEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStore((state) => selectRetryingOutageEnvironmentId(state, worktreeId))
}

export function useWorkspaceRuntimeEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStore((state) => selectWorkspaceRuntimeEnvironmentId(state, worktreeId))
}
