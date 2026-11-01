import type { UISlice } from '@/store/slices/ui'

export type WorktreeCreationSurfaceInput = {
  activeView: UISlice['activeView']
  activePendingCreationId: string | null
  hasActivePendingCreation: boolean
}

type WorktreeCreationViewState = Pick<UISlice, 'activeView'> & {
  activePendingCreationId: string | null
  activeWorktreeId: string | null
}

// The pending pointer can outlive the terminal view that actually renders its panel.
export function isPendingCreationSurfaceVisible(
  state: WorktreeCreationViewState,
  creationId: string
): boolean {
  return state.activeView === 'terminal' && state.activePendingCreationId === creationId
}

// The created row is listed before completion, so the user may already have opened it.
export function isCreatedWorkspaceInView(
  state: WorktreeCreationViewState,
  creationId: string,
  worktreeId: string
): boolean {
  return (
    isPendingCreationSurfaceVisible(state, creationId) ||
    (state.activeView === 'terminal' &&
      state.activePendingCreationId === null &&
      state.activeWorktreeId === worktreeId)
  )
}

export function shouldShowWorktreeCreationSurface({
  activeView,
  activePendingCreationId,
  hasActivePendingCreation
}: WorktreeCreationSurfaceInput): boolean {
  return activeView === 'terminal' && activePendingCreationId !== null && hasActivePendingCreation
}
