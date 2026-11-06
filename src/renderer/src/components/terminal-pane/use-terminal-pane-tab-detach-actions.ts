import { useCallback } from 'react'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '../../store'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget,
  type TerminalPaneNewTabTarget
} from './terminal-pane-tab-detach'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'

/** Moving a pane out to a new tab: by dragging it onto a tab strip, or for another client. */
export function useTerminalPaneTabDetachActions(controller: TerminalPaneBindingController) {
  const { managerRef, paneCwdRef, paneTransportsRef, persistLayoutSnapshot, tabId, worktreeId } =
    controller
  const resolveExternalPaneDropTarget = useCallback(
    ({
      sourcePaneId,
      clientX,
      clientY
    }: {
      sourcePaneId: number
      clientX: number
      clientY: number
    }) => {
      const panes = managerRef.current?.getPanes() ?? []
      if (panes.length <= 1 || !panes.some((pane) => pane.id === sourcePaneId)) {
        return null
      }
      return resolveTerminalTabStripDropTarget({
        clientX,
        clientY,
        groupsByWorktree: useAppStore.getState().groupsByWorktree,
        worktreeId
      })
    },
    [worktreeId, managerRef]
  )
  const detachPaneToNewTab = useCallback(
    (sourcePaneId: number, target: TerminalPaneNewTabTarget) => {
      const sourceTransport = paneTransportsRef.current.get(sourcePaneId)
      const livePtyId = sourceTransport?.getPtyId() ?? null
      const sourcePaneCwd = paneCwdRef.current.get(sourcePaneId)
      return detachTerminalPaneToTab({
        livePtyId,
        getStore: useAppStore.getState,
        manager: managerRef.current,
        persistLayoutSnapshot,
        sourcePaneId,
        ...(sourcePaneCwd ? { sourcePaneCwd } : {}),
        sourceConnectPending: sourceTransport?.isConnectPending?.() ?? false,
        sourceTabId: tabId,
        targetGroupId: target.groupId,
        targetIndex: target.index,
        ...(target.targetTabId ? { targetTabId: target.targetTabId } : {}),
        worktreeId
      })
    },
    [persistLayoutSnapshot, tabId, worktreeId, managerRef, paneCwdRef, paneTransportsRef]
  )
  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      void detachPaneToNewTab(sourcePaneId, {
        groupId: target.groupId,
        index: target.insertionIndex
      }).catch((error) => console.warn('[terminal-pane-detach] move failed', error))
      return true
    },
    [detachPaneToNewTab]
  )

  return { resolveExternalPaneDropTarget, handleExternalPaneDrop, detachPaneToNewTab }
}
