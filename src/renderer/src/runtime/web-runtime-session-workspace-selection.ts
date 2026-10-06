import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import {
  shouldRestoreWebRuntimeSessionWorkspaceSelection,
  type WebRuntimeSessionWorkspaceSelection
} from './web-runtime-session-workspace-routing'

export function selectWebRuntimeSessionWorktree(worktreeId: string, environmentId: string): void {
  useAppStore.getState().setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
}

export type WebRuntimeSessionWorkspaceSelectionRollback = {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
}

/** Selects the worktree for a create and returns what a failed create rolls back. */
export function selectWebRuntimeSessionWorktreeForCreate(
  worktreeId: string,
  environmentId: string
): WebRuntimeSessionWorkspaceSelectionRollback {
  const previous = readActiveWorkspaceSelection()
  selectWebRuntimeSessionWorktree(worktreeId, environmentId)
  return {
    previous,
    applied: { worktreeId, executionHostId: toRuntimeExecutionHostId(environmentId) }
  }
}

export function readActiveWorkspaceSelection(): WebRuntimeSessionWorkspaceSelection {
  const state = useAppStore.getState()
  return {
    worktreeId: state.activeWorktreeId ?? null,
    executionHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

export function restoreActiveWorkspaceSelection(
  rollback: WebRuntimeSessionWorkspaceSelectionRollback
): void {
  if (
    !shouldRestoreWebRuntimeSessionWorkspaceSelection({
      ...rollback,
      current: readActiveWorkspaceSelection()
    })
  ) {
    return
  }
  useAppStore
    .getState()
    .setActiveWorktree(rollback.previous.worktreeId, rollback.previous.executionHostId ?? undefined)
}

export function selectWebRuntimeSessionBrowserWorktree(
  worktreeId: string,
  environmentId: string
): void {
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeWorkspaceExecutionHostId !== toRuntimeExecutionHostId(environmentId)
  ) {
    state.setActiveWorktree(worktreeId, toRuntimeExecutionHostId(environmentId))
  }
}
