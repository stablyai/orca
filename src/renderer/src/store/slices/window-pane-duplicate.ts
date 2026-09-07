import type { AppState } from '../types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildSplitNode, replaceLeaf } from './tabs/tabs-layout'
import {
  captureEditorView,
  restoreTransferredEditorView
} from '@/components/editor/editor-view-transfer'

export function duplicateWorkspaceView(state: AppState, paneId: string): Partial<AppState> {
  const layout = state.windowPaneLayout
  const pane = layout?.panes[paneId]
  const view = layout?.views[pane?.selectedViewId ?? '']
  if (!layout || !pane || !view) {
    return {}
  }
  const id = createBrowserUuid()
  const destinationId = createBrowserUuid()
  const editorView = captureEditorView(view.id)
  if (editorView) {
    restoreTransferredEditorView(id, editorView)
  }
  return {
    windowPaneLayout: {
      ...layout,
      activePaneId: destinationId,
      expandedPaneId: null,
      root: replaceLeaf(
        layout.root,
        paneId,
        buildSplitNode(paneId, destinationId, 'horizontal', 'second')
      ),
      views: { ...layout.views, [id]: { ...view, id } },
      panes: {
        ...layout.panes,
        [destinationId]: {
          id: destinationId,
          viewIds: [id],
          selectedViewId: id,
          workspace: pane.workspace
        }
      }
    }
  }
}
