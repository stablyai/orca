import type { AppState } from '../types'
import { paneSelectionPatch, workspaceSessionKey } from './window-pane-selection'

/** Focus the existing placement when an old caller asks for a duplicate view. */
export function duplicateWorkspaceView(state: AppState, paneId: string): Partial<AppState> {
  const layout = state.windowPaneLayout
  const sourcePane = layout?.panes[paneId]
  const sourceView = layout?.views[sourcePane?.selectedViewId ?? '']
  if (!layout || !sourcePane || !sourceView) {
    return {}
  }
  const existing = Object.values(layout.views).find(
    (view) => workspaceSessionKey(view) === workspaceSessionKey(sourceView)
  )
  if (!existing) {
    return {}
  }
  if (existing.id === sourceView.id) {
    return {}
  }
  const destinationPane = Object.values(layout.panes).find((pane) =>
    pane.viewIds.includes(existing.id)
  )
  if (!destinationPane) {
    return {}
  }
  return {
    windowPaneLayout: {
      ...layout,
      activePaneId: destinationPane.id,
      expandedPaneId: null,
      panes: {
        ...layout.panes,
        [destinationPane.id]: { ...destinationPane, selectedViewId: existing.id }
      }
    },
    ...paneSelectionPatch(state, existing, destinationPane.workspace)
  }
}
