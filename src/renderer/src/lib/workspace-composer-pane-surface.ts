import type { TopLevelView } from '../../../shared/ui-chrome-types'
import type { AppState } from '@/store/types'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'

type WorkspaceComposerPaneSurfaceInput = {
  activeView: TopLevelView
  activeModal: string
  /** Another modal took the slot while the pane hosted the composer. */
  composerParked: boolean
  promptFirstComposer: boolean
  /** A visible worktree creation already owns the center pane. */
  creationSurfaceActive: boolean
}

/**
 * The prompt-first composer takes over the center pane instead of opening a dialog.
 * Why: while a creation panel is showing, the composer falls back to the dialog so the
 * two center surfaces never stack.
 */
export function shouldShowWorkspaceComposerPane({
  activeView,
  activeModal,
  composerParked,
  promptFirstComposer,
  creationSurfaceActive
}: WorkspaceComposerPaneSurfaceInput): boolean {
  return (
    promptFirstComposer &&
    !creationSurfaceActive &&
    activeView === 'terminal' &&
    (activeModal === 'new-workspace-composer' || composerParked)
  )
}

export function selectWorkspaceComposerPaneActive(
  s: Pick<
    AppState,
    | 'activeView'
    | 'activeModal'
    | 'parkedComposerModalData'
    | 'settings'
    | 'activePendingCreationId'
    | 'pendingWorktreeCreations'
  >
): boolean {
  return shouldShowWorkspaceComposerPane({
    activeView: s.activeView,
    activeModal: s.activeModal,
    composerParked: s.parkedComposerModalData !== null,
    promptFirstComposer: s.settings?.promptFirstComposer === true,
    creationSurfaceActive: shouldShowWorktreeCreationSurface({
      activeView: s.activeView,
      activePendingCreationId: s.activePendingCreationId,
      hasActivePendingCreation:
        s.activePendingCreationId !== null &&
        s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
    })
  })
}
