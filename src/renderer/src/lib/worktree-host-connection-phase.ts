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
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

/**
 * `local`: no SSH target this client dials for the worktree — a local workspace, a
 * runtime-owned target, or an owner that has not resolved yet.
 */
export type WorktreeHostConnectionPhase = 'local' | 'connecting' | 'connected' | 'unavailable'

export type WorktreeHostConnection = {
  phase: WorktreeHostConnectionPhase
  targetId: string | null
  /** Bumps on every reconnect, so a consumer can re-derive what it prepared on the old one. */
  connectionGeneration: number | null
}

export type WorktreeSshTarget = {
  targetId: string
  /** The remote runtime whose mirrored SSH state owns the target; null for this client's own. */
  environmentId: string | null
}

const LOCAL_HOST_CONNECTION: WorktreeHostConnection = {
  phase: 'local',
  targetId: null,
  connectionGeneration: null
}

/** The SSH target a worktree's panes reach through, or null when this client dials none. */
export function resolveWorktreeSshTarget(
  state: AppState,
  worktreeId: string,
  connectionId: string | null | undefined
): WorktreeSshTarget | null {
  if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
    return null
  }
  return {
    targetId: connectionId,
    environmentId: getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}

function deriveSshTargetPhase(
  state: AppState,
  target: WorktreeSshTarget
): WorktreeHostConnectionPhase {
  const status = selectRuntimeAwareSshStatus(state, target.environmentId, target.targetId)
  if (status === 'connected') {
    return 'connected'
  }
  if (isConnectingSshStatus(status)) {
    return 'connecting'
  }
  // Why: startup restoration dials the targets that were live at shutdown; until it publishes,
  // a missing entry means "not dialed yet", not "disconnected". Restoration finishing (or
  // degrading) ends this on its own.
  if (
    target.environmentId === null &&
    !state.terminalStartupRestorationReady &&
    !state.sshConnectionStates.has(target.targetId)
  ) {
    return 'connecting'
  }
  return 'unavailable'
}

/** Whether a worktree's SSH host is reachable yet, derived from the published SSH state. */
export function selectWorktreeHostConnectionPhase(
  state: AppState,
  worktreeId: string | null
): WorktreeHostConnection {
  if (!worktreeId) {
    return LOCAL_HOST_CONNECTION
  }
  const target = resolveWorktreeSshTarget(
    state,
    worktreeId,
    getConnectionIdFromState(state, worktreeId)
  )
  if (!target) {
    return LOCAL_HOST_CONNECTION
  }
  return {
    phase: deriveSshTargetPhase(state, target),
    targetId: target.targetId,
    connectionGeneration: selectRuntimeAwareSshConnectionGeneration(
      state,
      target.environmentId,
      target.targetId
    )
  }
}

export function useWorktreeHostConnection(worktreeId: string | null): WorktreeHostConnection {
  return useAppStore(useShallow((state) => selectWorktreeHostConnectionPhase(state, worktreeId)))
}
