import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { tailscaleHostOfEndpoint } from '../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import type { RemoteRuntimeRecoveryCause } from './remote-runtime-recovery-copy'

/**
 * The server owning this workspace while its shared connection is down and retrying on its own.
 * One server-level reading, so its panes stay quiet instead of each announcing the same drop.
 */
export function selectRetryingOutageEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  if (!environmentId) {
    return null
  }
  // Why only 'reconnecting': it is the transport-down verdict. 'checking' and a failed status
  // probe over a live socket are not a dropped connection, and must not be announced as one.
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
