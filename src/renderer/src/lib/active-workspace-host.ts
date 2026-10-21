import type { ExecutionHostId } from '../../../shared/execution-host'

type SelectionState = {
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

type SelectingState = SelectionState & {
  setActiveWorktree: (worktreeId: string | null, executionHostId?: ExecutionHostId) => unknown
}

/**
 * The selected workspace as one value. Worktree ids repeat across hosts, so a selection saved or
 * restored by id alone loses which copy of a same-id twin the user was on.
 */
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

/** The host the user selected for `worktreeId` when it is the active workspace; else null. */
export function getActiveWorkspaceExecutionHostId(
  state: SelectionState,
  worktreeId: string
): ExecutionHostId | null {
  return state.activeWorktreeId === worktreeId
    ? (state.activeWorkspaceExecutionHostId ?? null)
    : null
}

/** Re-selects `worktreeId`; when it is already active, keeps the selected copy of a same-id twin. */
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
