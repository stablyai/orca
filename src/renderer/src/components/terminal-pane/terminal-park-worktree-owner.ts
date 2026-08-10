/**
 * Resolves the transport owner a worktree's own terminals spawn against, for the
 * park predicate to compare a remote pty id's embedded owner with.
 *
 * Why separate from terminal-park-pty-restore-eligibility: that module stays a
 * pure predicate over ids, with no store dependency.
 */
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  getConnectionIdFromState,
  type ConnectionOwnerState
} from '@/lib/connection-owner-resolution'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { TerminalParkWorktreeOwner } from './terminal-park-pty-restore-eligibility'

export type TerminalParkWorktreeOwnerState = ConnectionOwnerState & WorktreeRuntimeOwnerState

export function getTerminalParkWorktreeOwner(
  state: ConnectionOwnerState & WorktreeRuntimeOwnerState,
  worktreeId: string | null
): TerminalParkWorktreeOwner {
  return {
    // Why the transport resolvers, not the execution host: a worktree reached
    // through a paired HUB keeps its SSH host while the HUB owns its ptys.
    connectionId: getConnectionIdFromState(state, worktreeId),
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}

/** Why subscribed: ownership hydrates after the tabs do; memoized so it can key effects. */
export function useTerminalParkWorktreeOwner(worktreeId: string | null): TerminalParkWorktreeOwner {
  const connectionId = useAppStore((state) => getConnectionIdFromState(state, worktreeId))
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  return useMemo(
    () => ({ connectionId, runtimeEnvironmentId }),
    [connectionId, runtimeEnvironmentId]
  )
}

/** Subscribes a many-worktree parking pass to every transport-owner authority slice. */
export function useTerminalParkWorktreeOwnerState(): TerminalParkWorktreeOwnerState {
  return useAppStore(
    useShallow((state) => ({
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      activeWorktreeId: state.activeWorktreeId,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      repos: state.repos,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      runtimeEnvironments: state.runtimeEnvironments,
      settings: state.settings,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
}
