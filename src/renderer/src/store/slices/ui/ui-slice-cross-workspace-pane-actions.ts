import type { UISlice, UISliceSet } from './ui-slice-contract'

export function createUiCrossWorkspacePaneActions(set: UISliceSet): Partial<UISlice> {
  return {
    crossWorkspacePane: null,
    setCrossWorkspacePane: (pane) => {
      window.api.ui.set({ crossWorkspacePane: pane }).catch(console.error)
      set({ crossWorkspacePane: pane })
    }
  }
}
