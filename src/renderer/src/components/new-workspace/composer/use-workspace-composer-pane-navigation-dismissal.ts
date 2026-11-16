import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { hasNavigatedAwayFromWorkspaceComposerPane } from '@/lib/workspace/creation/workspace-composer-pane-surface'

/** Dismisses the pane composer once the user navigates away from the center it opened over. */
export function useWorkspaceComposerPaneNavigationDismissal(): void {
  const navigatedAwayRequest = useAppStore((state) => {
    const request = state.workspaceComposerPaneRequest
    return request && hasNavigatedAwayFromWorkspaceComposerPane(state, request) ? request : null
  })
  const closeWorkspaceComposerPane = useAppStore((state) => state.closeWorkspaceComposerPane)
  useEffect(() => {
    if (navigatedAwayRequest) {
      closeWorkspaceComposerPane(navigatedAwayRequest)
    }
  }, [navigatedAwayRequest, closeWorkspaceComposerPane])
}
