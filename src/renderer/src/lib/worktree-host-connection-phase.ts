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
  return 'unavailable'
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

export function useWorktreeHostConnection(worktreeId: string | null): WorktreeHostConnection {
  return useAppStore(useShallow((state) => selectWorktreeHostConnectionPhase(state, worktreeId)))
}
