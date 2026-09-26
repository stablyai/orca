import type { TopLevelView } from '../../../shared/ui-chrome-types'

type WorkspaceComposerPaneSurfaceInput = {
  activeView: TopLevelView
  activeModal: string
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
  promptFirstComposer,
  creationSurfaceActive
}: WorkspaceComposerPaneSurfaceInput): boolean {
  return (
    promptFirstComposer &&
    !creationSurfaceActive &&
    activeView === 'terminal' &&
    activeModal === 'new-workspace-composer'
  )
}
