import type { ExecutionHostId } from '../../../shared/execution-host'

type SelectionState = {
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

type SelectingState = SelectionState & {
  setActiveWorktree: (worktreeId: string | null, executionHostId?: ExecutionHostId) => unknown
}

/** Workspace IDs repeat across hosts; persist selection with its owner to preserve the chosen same-ID copy. */
export type WorkspaceSelection = {
  worktreeId: string | null
  executionHostId: ExecutionHostId | null
}

export function captureWorkspaceSelection(state: SelectionState): WorkspaceSelection {
  return {
    worktreeId: state.activeWorktreeId ?? null,
    executionHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

export function isWorkspaceSelected(state: SelectionState, selection: WorkspaceSelection): boolean {
  const current = captureWorkspaceSelection(state)
  return (
    current.worktreeId === selection.worktreeId &&
    current.executionHostId === selection.executionHostId
  )
}

export function restoreWorkspaceSelection(
  state: SelectingState,
  selection: WorkspaceSelection
): void {
  if (selection.executionHostId) {
    state.setActiveWorktree(selection.worktreeId, selection.executionHostId)
  } else {
    state.setActiveWorktree(selection.worktreeId)
  }
}

export function getActiveWorkspaceExecutionHostId(
  state: SelectionState,
  worktreeId: string
): ExecutionHostId | null {
  return state.activeWorktreeId === worktreeId
    ? (state.activeWorkspaceExecutionHostId ?? null)
    : null
}

export function reselectWorkspaceKeepingHost(
  state: SelectionState & {
    setActiveWorktree: (worktreeId: string, executionHostId?: ExecutionHostId) => unknown
  },
  worktreeId: string
): void {
  const executionHostId = getActiveWorkspaceExecutionHostId(state, worktreeId)
  if (executionHostId) {
    state.setActiveWorktree(worktreeId, executionHostId)
  } else {
    state.setActiveWorktree(worktreeId)
  }
}
