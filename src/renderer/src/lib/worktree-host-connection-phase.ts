import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  selectRuntimeAwareSshConnectionGeneration,
  selectRuntimeAwareSshStatus
} from '@/store/slices/runtime-environment-ssh'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

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
  /** The status behind `phase`; null when local or unverifiable. */
  status: SshConnectionStatus | null
  /** Names the live connection: null unless connected, and new on every reconnect. */
  connectedEpoch: string | null
}

const LOCAL_HOST_CONNECTION: WorktreeHostConnection = {
  phase: 'local',
  targetId: null,
  environmentId: null,
  status: null,
  connectedEpoch: null
}

function selectTargetStatus(
  state: AppState,
  targetId: string,
  environmentId: string | null
): SshConnectionStatus | null {
  // Why: startup restoration dials the targets that were live at shutdown; until it publishes,
  // a missing entry means "not dialed yet", not "disconnected". Restoration finishing (or
  // degrading) ends this on its own.
  if (
    environmentId === null &&
    !state.terminalStartupRestorationReady &&
    !state.sshConnectionStates.has(targetId)
  ) {
    return 'connecting'
  }
  return selectRuntimeAwareSshStatus(state, environmentId, targetId)
}

function phaseForStatus(status: SshConnectionStatus | null): WorktreeHostConnectionPhase {
  if (status === null) {
    return 'unverifiable'
  }
  if (status === 'connected') {
    return 'connected'
  }
  return isConnectingSshStatus(status) ? 'connecting' : 'unavailable'
}

/** The shared signal for a caller that already resolved the worktree's connection id. */
export function resolveWorktreeHostConnection(
  state: AppState,
  worktreeId: string,
  targetId: string | null | undefined
): WorktreeHostConnection {
  if (!targetId || isRuntimeOwnedSshTargetId(targetId)) {
    return LOCAL_HOST_CONNECTION
  }
  const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const status = selectTargetStatus(state, targetId, environmentId)
  const generation = selectRuntimeAwareSshConnectionGeneration(state, environmentId, targetId)
  return {
    phase: phaseForStatus(status),
    targetId,
    environmentId,
    status,
    connectedEpoch: status === 'connected' ? `${targetId}:${generation ?? ''}` : null
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

export function useWorktreeHostConnection(worktreeId: string | null): WorktreeHostConnection {
  return useAppStore(useShallow((state) => selectWorktreeHostConnectionPhase(state, worktreeId)))
}
