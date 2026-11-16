import type { AppState } from '@/store/types'
import type { WorkspaceComposerPaneRequest } from '@/store/slices/ui/ui-slice-contract-contextual'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'

type PaneSurfaceState = Pick<
  AppState,
  | 'activeView'
  | 'activeWorktreeId'
  | 'activePendingCreationId'
  | 'pendingWorktreeCreations'
  | 'settings'
>

/**
 * Whether an opened composer belongs in the center pane rather than the dialog.
 * Why: a creation panel already owning the center, or direct work-item setup, keeps the dialog.
 */
export function canHostWorkspaceComposerPane(
  state: PaneSurfaceState,
  data: Record<string, unknown>
): boolean {
  return (
    state.settings?.promptFirstComposer === true &&
    state.activeView === 'terminal' &&
    !selectWorktreeCreationSurfaceShown(state) &&
    !data.directSetup
  )
}

/** The center the pane request was opened over; leaving it dismisses the pane. */
export function captureWorkspaceComposerPaneOrigin(
  state: Pick<AppState, 'activeWorktreeId' | 'activePendingCreationId'>
): WorkspaceComposerPaneRequest['origin'] {
  return {
    worktreeId: state.activeWorktreeId,
    pendingCreationId: state.activePendingCreationId
  }
}

/** Why: the pane is not modal, so the sidebar or a view switch can navigate away from under it. */
export function hasNavigatedAwayFromWorkspaceComposerPane(
  state: Pick<AppState, 'activeView' | 'activeWorktreeId' | 'activePendingCreationId'>,
  request: WorkspaceComposerPaneRequest
): boolean {
  return (
    state.activeView !== 'terminal' ||
    state.activeWorktreeId !== request.origin.worktreeId ||
    state.activePendingCreationId !== request.origin.pendingCreationId
  )
}

export function selectWorkspaceComposerPaneActive(
  state: PaneSurfaceState & Pick<AppState, 'workspaceComposerPaneRequest'>
): boolean {
  const request = state.workspaceComposerPaneRequest
  return request !== null && !hasNavigatedAwayFromWorkspaceComposerPane(state, request)
}

/** The open composer's data, wherever it is hosted; null when no composer is open. */
export function selectOpenWorkspaceComposerData(
  state: Pick<AppState, 'activeModal' | 'modalData' | 'workspaceComposerPaneRequest'>
): Record<string, unknown> | null {
  if (state.workspaceComposerPaneRequest) {
    return state.workspaceComposerPaneRequest.data
  }
  return state.activeModal === 'new-workspace-composer' ? state.modalData : null
}

/** Why: a recovery reopen must not replace whatever dialog or composer the user moved on to. */
export function isModalSurfaceIdle(
  state: Pick<AppState, 'activeModal' | 'workspaceComposerPaneRequest'>
): boolean {
  return state.activeModal === 'none' && state.workspaceComposerPaneRequest === null
}
