import { useLayoutEffect } from 'react'
import { useAppStore } from '@/store'
import { paneSelectionPatch, resolveWorkspaceView } from '@/store/slices/window-pane-selection'

export function useWindowPaneNavigation(): void {
  useLayoutEffect(() => {
    let initialized = false
    let synchronizing = false
    let pendingViewId: string | null = null
    const synchronize = (unplacedOnly = false): void => {
      const state = useAppStore.getState()
      if (synchronizing || !state.persistedUIReady || !state.hydrationSucceeded) {
        return
      }
      synchronizing = true
      try {
        const layout = state.windowPaneLayout
        const pane = layout?.panes[layout.activePaneId]
        const view = layout?.views[pane?.selectedViewId ?? '']
        if (
          layout &&
          pane &&
          (!initialized ||
            (pendingViewId === view?.id &&
              state.activeWorktreeId === view.worktreeId &&
              state.activeWorkspaceExecutionHostId === view.executionHostId))
        ) {
          pendingViewId = view && !resolveWorkspaceView(state, view) ? view.id : null
          useAppStore.setState(
            paneSelectionPatch(state, layout.views[pane.selectedViewId ?? ''], pane.workspace)
          )
        } else {
          pendingViewId = null
          state.initializeWindowPanes()
          const selectionUnchanged =
            view &&
            state.activeWorktreeId === view.worktreeId &&
            state.activeWorkspaceExecutionHostId === view.executionHostId &&
            state.getActiveTab(view.worktreeId)?.id === view.tabId
          state.synchronizeWindowPaneSelection(unplacedOnly || selectionUnchanged)
        }
        initialized = true
      } finally {
        synchronizing = false
      }
    }
    synchronize()
    return useAppStore.subscribe((state, previous) => {
      if (initialized && state.windowPaneLayout !== previous.windowPaneLayout) {
        pendingViewId = null
        return
      }
      const worktreeId = state.activeWorktreeId
      const previousTabId = worktreeId
        ? previous.groupsByWorktree[worktreeId]?.find(
            (group) => group.id === previous.activeGroupIdByWorktree[worktreeId]
          )?.activeTabId
        : undefined
      const activeTabChanged =
        worktreeId !== null && state.getActiveTab(worktreeId)?.id !== previousTabId
      if (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree) {
        synchronize(
          !activeTabChanged &&
            state.activeWorktreeId === previous.activeWorktreeId &&
            state.activeWorkspaceExecutionHostId === previous.activeWorkspaceExecutionHostId
        )
        return
      }
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
        state.activeTabId !== previous.activeTabId ||
        state.activeFileId !== previous.activeFileId ||
        state.activeBrowserTabId !== previous.activeBrowserTabId ||
        state.activeTabType !== previous.activeTabType ||
        state.persistedUIReady !== previous.persistedUIReady ||
        state.hydrationSucceeded !== previous.hydrationSucceeded
      ) {
        synchronize()
      } else if (state.groupsByWorktree !== previous.groupsByWorktree) {
        synchronize(!activeTabChanged)
      }
    })
  }, [])
}
