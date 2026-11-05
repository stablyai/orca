import { useAppStore } from '@/store'
import { selectWorkspaceComposerPaneActive } from '@/lib/workspace-composer-pane-surface'
import { useComposerPaneHandoff } from './use-composer-pane-handoff'

/** Whether the composer dialog stays empty because the prompt-first center pane owns the composer. */
export function useComposerDialogYieldsToPane(dialogOpen: boolean): boolean {
  // Why: the prompt-first composer renders in the center pane (NewWorkspaceComposerPane) instead.
  const paneActive = useAppStore(selectWorkspaceComposerPaneActive)
  const composerParked = useAppStore((s) => s.parkedComposerModalData !== null)
  const closeWorkspaceComposer = useAppStore((s) => s.closeWorkspaceComposer)
  const workspaceViewActive = useAppStore((s) => s.activeView === 'terminal')
  // Why: leaving the workspace view while the pane hosts the composer dismisses it instead of
  // re-hosting it here as an empty dialog.
  const handingOff = useComposerPaneHandoff({
    composerOpen: dialogOpen || composerParked,
    paneActive,
    workspaceViewActive,
    closeComposer: closeWorkspaceComposer
  })
  return paneActive || handingOff
}
