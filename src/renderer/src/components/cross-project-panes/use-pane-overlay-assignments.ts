import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { resolveWorkspaceView } from '@/store/slices/window-pane-selection'
import {
  isWorkspaceViewController,
  useWorkspaceViewControlRevision
} from './workspace-view-control-state'

export function usePaneOverlayAssignments(worktreeId: string) {
  useWorkspaceViewControlRevision()
  const layout = useAppStore((s) => s.windowPaneLayout)
  const tabs = useAppStore((s) => s.unifiedTabsByWorktree[worktreeId])
  const assignments = (() => {
    if (!layout) {
      return null
    }
    const entries = new Map<
      string,
      { groupId: string; viewId: string; isActiveInGroup: boolean; isFocused: boolean }
    >()
    for (const pane of Object.values(layout.panes)) {
      for (const id of pane.viewIds) {
        const view = layout.views[id]
        if (
          view.worktreeId !== worktreeId ||
          !resolveWorkspaceView(useAppStore.getState(), view, tabs)
        ) {
          continue
        }
        if (
          (view.contentType === 'terminal' || view.contentType === 'browser') &&
          !isWorkspaceViewController(view)
        ) {
          continue
        }
        if (entries.get(view.tabId)?.isActiveInGroup) {
          continue
        }
        entries.set(view.tabId, {
          groupId: pane.id,
          viewId: id,
          isActiveInGroup:
            pane.selectedViewId === id &&
            (!layout.expandedPaneId || layout.expandedPaneId === pane.id),
          isFocused: layout.activePaneId === pane.id
        })
      }
    }
    return entries
  })()
  const focus = useCallback(
    (id: string) => {
      const state = useAppStore.getState()
      if (state.windowPaneLayout) {
        state.focusWindowPane(id)
      } else {
        state.focusGroup(worktreeId, id)
      }
    },
    [worktreeId]
  )
  return useMemo(
    () => ({ assignments, focus, activePaneId: layout?.activePaneId }),
    [assignments, focus, layout?.activePaneId]
  )
}
