import type { AppState } from '../types'
import type { WorkspacePaneDropTarget } from '../../../../shared/window-pane-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildSplitNode, replaceLeaf } from './tabs/tabs-layout'
import { paneSelectionPatch, workspaceTabKey } from './window-pane-selection'

export function moveWorkspaceView(
  state: AppState,
  viewId: string,
  target: WorkspacePaneDropTarget
): Partial<AppState> {
  const layout = state.windowPaneLayout
  const source = Object.values(layout?.panes ?? {}).find((pane) => pane.viewIds.includes(viewId))
  const destination = layout?.panes[target.paneId]
  if (!layout || !source || !destination || target.beforeViewId === viewId) {
    return {}
  }
  const view = layout.views[viewId]
  const viewIds = source.viewIds.filter((id) => id !== viewId)
  const panes = {
    ...layout.panes,
    [source.id]: {
      ...source,
      viewIds,
      selectedViewId:
        source.selectedViewId === viewId ? (viewIds.at(-1) ?? null) : source.selectedViewId,
      dismissedTabKeys: [...new Set([...(source.dismissedTabKeys ?? []), workspaceTabKey(view)])]
    }
  }
  let root = layout.root
  let paneId = target.paneId
  if (target.zone === 'center') {
    const pane = panes[paneId]
    const ids = [...pane.viewIds]
    const index = target.beforeViewId ? ids.indexOf(target.beforeViewId) : ids.length
    ids.splice(index < 0 ? ids.length : index, 0, viewId)
    panes[paneId] = {
      ...pane,
      viewIds: ids,
      selectedViewId: viewId,
      dismissedTabKeys: pane.dismissedTabKeys?.filter((key) => key !== workspaceTabKey(view))
    }
  } else {
    paneId = createBrowserUuid()
    root = replaceLeaf(
      root,
      target.paneId,
      buildSplitNode(
        target.paneId,
        paneId,
        target.zone === 'left' || target.zone === 'right' ? 'horizontal' : 'vertical',
        target.zone === 'left' || target.zone === 'up' ? 'first' : 'second'
      )
    )
    panes[paneId] = {
      id: paneId,
      viewIds: [viewId],
      selectedViewId: viewId,
      workspace: { worktreeId: view.worktreeId, executionHostId: view.executionHostId }
    }
  }
  return {
    windowPaneLayout: { ...layout, root, panes, activePaneId: paneId, expandedPaneId: null },
    ...paneSelectionPatch(state, view)
  }
}
