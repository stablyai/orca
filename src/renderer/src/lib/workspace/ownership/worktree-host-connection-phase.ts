import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import '@/lib/connection-context'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import '@/store/slices/runtime-environment-ssh'
import {
  selectRuntimeAwareSshConnectionGeneration,
  selectRuntimeAwareSshStatus
} from '@/store/slices/runtime-environment-ssh-selectors'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { SshConnectionStatus } from '../../../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../../../shared/execution-host'
import { getOrcadSshDeployment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isConnectedRuntimeHostState } from '../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'

/**
 * `local`: no SSH target this client dials for the worktree — a local workspace, a
 * runtime-owned target, or an owner that has not resolved yet.
 * `unverifiable`: the owning remote runtime is unreachable or has not published its SSH
 * state, so this client cannot see the target — not evidence that it is down.
 */
export type WorktreeHostConnectionPhase =
  | 'local'
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'unverifiable'

export type WorktreeHostConnection = {
  phase: WorktreeHostConnectionPhase
  targetId: string | null
  /** The remote runtime whose mirrored SSH state owns the target; null for this client's own. */
  environmentId: string | null
  /**
   * The status as published, before `phase` reads an undialed startup target as connecting.
   * Surfaces that name the status itself (the terminal's reconnect overlay) read this; null
   * when local or unverifiable.
   */
  publishedStatus: SshConnectionStatus | null
  /** Names the live connection: null unless connected, and new on every reconnect. */
  connectedEpoch: string | null
}

const LOCAL_HOST_CONNECTION: WorktreeHostConnection = {
  phase: 'local',
  targetId: null,
  environmentId: null,
  publishedStatus: null,
  connectedEpoch: null
}

function derivePhase(
  state: AppState,
  targetId: string,
  environmentId: string | null,
  publishedStatus: SshConnectionStatus | null
): WorktreeHostConnectionPhase {
  if (publishedStatus === null) {
    return 'unverifiable'
  }
  if (publishedStatus === 'connected') {
    return 'connected'
  }
  if (isConnectingSshStatus(publishedStatus)) {
    return 'connecting'
  }
  // Missing startup SSH state means not dialed yet until restoration finishes or degrades.
  if (
    environmentId === null &&
    !state.terminalStartupRestorationReady &&
    !state.sshConnectionStates.has(targetId)
  ) {
    return 'connecting'
  }
  return 'unavailable'
}

/** The shared signal for a caller that already resolved the worktree's connection id. */
export function resolveWorktreeHostConnection(
  state: AppState,
  worktreeId: string | null,
  targetId: string | null | undefined,
  environmentIdOverride?: string | null
): WorktreeHostConnection {
  if (!targetId || isRuntimeOwnedSshTargetId(targetId)) {
    return LOCAL_HOST_CONNECTION
  }
  const environmentId =
    environmentIdOverride === undefined
      ? // This phase reads only SSH state; its twin reads the direct connection.
        runtimeEnvironmentIdUnlessTwin(state, worktreeId)
      : environmentIdOverride
  const publishedStatus = selectRuntimeAwareSshStatus(state, environmentId, targetId)
  const generation = selectRuntimeAwareSshConnectionGeneration(state, environmentId, targetId)
  return {
    phase: derivePhase(state, targetId, environmentId, publishedStatus),
    targetId,
    environmentId,
    publishedStatus,
    connectedEpoch: publishedStatus === 'connected' ? `${targetId}:${generation ?? ''}` : null
  }
}

/**
 * The one reading of a worktree's SSH host that every pane shares, derived from the
 * published SSH state. Panes must not re-derive status or reconnect identity themselves.
 */
export function selectWorktreeHostConnectionPhase(
  state: AppState,
  worktreeId: string | null
): WorktreeHostConnection {
  if (!worktreeId) {
    return LOCAL_HOST_CONNECTION
  }
  return resolveWorktreeHostConnection(
    state,
    worktreeId,
    getConnectionIdFromState(state, worktreeId)
  )
}

/**
 * The SSH connection this client's browser route dials. A recipe VM's target publishes no SSH
 * state, but its server's tunnel runs over that same connection, so the server's state stands in.
 */
export function resolveBrowserRouteHostConnection(
  state: AppState,
  worktreeId: string | null,
  targetId: string | null
): WorktreeHostConnection {
  if (!targetId || !isRuntimeOwnedSshTargetId(targetId)) {
    return resolveWorktreeHostConnection(state, worktreeId, targetId, null)
  }
  const environmentId = state.runtimeEnvironments?.find(
    (environment) => getOrcadSshDeployment(environment)?.sshTargetId === targetId
  )?.id
  if (!environmentId) {
    return LOCAL_HOST_CONNECTION
  }
  const entry = state.runtimeStatusByEnvironmentId?.get(environmentId)
  const hostState = runtimeHostConnectionStateForEntry(entry)
  const connected = isConnectedRuntimeHostState(hostState)
  // Only a live dial waits; lost or never-attempted contact settles so the route card offers recovery.
  return {
    phase: connected
      ? 'connected'
      : entry && hostState === 'checking'
        ? 'connecting'
        : 'unavailable',
    targetId,
    environmentId: null,
    publishedStatus: null,
    connectedEpoch: connected
      ? `${targetId}:${entry?.connectionGeneration ?? ''}:${entry?.hostContactEpoch ?? ''}`
      : null
  }
}

export function useWorktreeHostConnection(
  worktreeId: string | null,
  browserRouteTargetId?: string | null
): WorktreeHostConnection {
  return useAppStore(
    useShallow((state) =>
      browserRouteTargetId === undefined
        ? selectWorktreeHostConnectionPhase(state, worktreeId)
        : resolveBrowserRouteHostConnection(state, worktreeId, browserRouteTargetId)
    )
  )
}
