import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { resolveWorkspaceComposerPaneExit } from '@/lib/workspace/creation/workspace-composer-pane-surface'

/** Settles the pane composer once the user navigates away from the center it opened over. */
export function useWorkspaceComposerPaneNavigationDismissal(): void {
  const request = useAppStore((state) => state.workspaceComposerPaneRequest)
  const exit = useAppStore((state) =>
    state.workspaceComposerPaneRequest
      ? resolveWorkspaceComposerPaneExit(state, state.workspaceComposerPaneRequest)
      : 'stay'
  )
  const closeWorkspaceComposerPane = useAppStore((state) => state.closeWorkspaceComposerPane)
  const moveWorkspaceComposerPaneToDialog = useAppStore(
    (state) => state.moveWorkspaceComposerPaneToDialog
  )
  useEffect(() => {
    if (!request || exit === 'stay') {
      return
    }
    if (exit === 'move-to-dialog') {
      moveWorkspaceComposerPaneToDialog(request)
    } else {
      closeWorkspaceComposerPane(request)
    }
  }, [request, exit, closeWorkspaceComposerPane, moveWorkspaceComposerPaneToDialog])
}
