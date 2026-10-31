import { workspacePresentationFor } from '@/store/workspace-source-state'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import {
  shouldRestoreWebRuntimeSessionWorkspaceSelection,
  type WebRuntimeSessionWorkspaceSelection
} from './web-runtime-session-workspace-routing'

export function selectWebRuntimeSessionWorktree(worktreeId: string, environmentId: string): void {
  const state = useAppStore.getState()
  const saved = workspacePresentationFor(state, worktreeId)
  state.setActiveWorktree(
    saved?.displayWorkspaceId ?? worktreeId,
    saved
      ? (saved.anchor.executionHostId ?? saved.anchor.hostId)
      : toRuntimeExecutionHostId(environmentId)
  )
}

export type WebRuntimeSessionWorkspaceSelectionRollback = {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
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
  const saved = workspacePresentationFor(state, worktreeId)
  const displayId = saved?.displayWorkspaceId ?? worktreeId
  const hostId = saved
    ? (saved.anchor.executionHostId ?? saved.anchor.hostId)
    : toRuntimeExecutionHostId(environmentId)
  if (state.activeWorktreeId !== displayId || state.activeWorkspaceExecutionHostId !== hostId) {
    state.setActiveWorktree(displayId, hostId)
  }
}
