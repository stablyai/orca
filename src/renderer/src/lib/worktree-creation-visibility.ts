import { useAppStore } from '@/store'

// The pending pointer can survive app-view changes; only terminal view actually displays creation UI.
export function isPendingCreationSurfaceVisible(creationId: string): boolean {
  const state = useAppStore.getState()
  return state.activeView === 'terminal' && state.activePendingCreationId === creationId
}

// Why: the created row is listed before completion, so a user may already have opened it.
export function isCreatedWorkspaceInView(creationId: string, worktreeId: string): boolean {
  const state = useAppStore.getState()
  return (
    isPendingCreationSurfaceVisible(creationId) ||
    (state.activeView === 'terminal' &&
      state.activePendingCreationId === null &&
      state.activeWorktreeId === worktreeId)
  )
}
