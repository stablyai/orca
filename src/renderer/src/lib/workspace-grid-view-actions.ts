import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from './worktree-activation'

/** Adds a workspace and opens the grid view when the user is looking at a workspace outside it. */
export function addWorkspaceToGridViewAndShow(workspaceId: string): void {
  useAppStore.getState().addWorkspaceToGridView(workspaceId)
  const { workspaceGridViewMemberIds, activeWorktreeId } = useAppStore.getState()
  // Why: the grid view shows only while one of its members is active.
  if (!activeWorktreeId || !workspaceGridViewMemberIds.includes(activeWorktreeId)) {
    activateAndRevealWorkspace(workspaceId)
  }
}

/** Removes a workspace; when it held focus, focus moves to another member so the grid view stays put. */
export function removeWorkspaceFromGridViewKeepingFocus(workspaceId: string): void {
  const state = useAppStore.getState()
  const nextFocusId =
    state.activeWorktreeId === workspaceId
      ? (state.workspaceGridViewMemberIds.find((id) => id !== workspaceId) ?? null)
      : null
  state.removeWorkspaceFromGridView(workspaceId)
  if (nextFocusId) {
    activateAndRevealWorkspace(nextFocusId)
  }
}

export function focusWorkspaceGridViewMember(workspaceId: string): void {
  if (useAppStore.getState().activeWorktreeId !== workspaceId) {
    activateAndRevealWorkspace(workspaceId)
  }
}
