import { selectWorkspaceRuntimeEnvironmentId } from '../../../../../lib/workspace/ownership/workspace-runtime-environment'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { toRuntimeExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import { tailscaleHostOfEndpoint } from '../../../../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RemoteRuntimeRecoveryCause } from '../../remote-runtime/recovery/remote-runtime-recovery-copy'

/** Read shared server reconnection once so individual panes do not announce the same outage. */
export function selectRetryingOutageEnvironmentId(
  state: AppState,
  statuses: RuntimeStatuses,
  worktreeId: string | null | undefined
): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  if (!environmentId) {
    return null
  }
  // Only reconnecting proves transport loss; checking or failed probes over a live socket do not.
  const entry = statuses.get(environmentId)
  return runtimeHostConnectionStateForEntry(entry) === 'reconnecting' ? environmentId : null
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
  return useAppStoreWithHostStatuses((state, statuses) =>
    selectRetryingOutageEnvironmentId(state, statuses, worktreeId)
  )
}
