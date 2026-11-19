import { useCallback, useEffect } from 'react'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager-types'
import { useAppStore } from '../../../../store/index'
import { detachTerminalPaneToTab, type TerminalPaneNewTabTarget } from './terminal-pane-tab-detach'
import {
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-tab-strip-drop-target'
import type { TerminalPaneBindingController } from '../ownership/use-terminal-pane-layout-bindings'
import { paneMoveReadiness, type PaneMoveReadiness } from './terminal-pane-move-readiness'
import { focusMovedPane, newTabTargetBesideSource } from './terminal-pane-move-placement'
import { registerTerminalPaneUserMoveHandler } from './terminal-pane-move-request-routing'

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
      })
        .then((moved) => moved && focusMovedPane(tabId, moved))
        .catch((error) => console.warn('[terminal-pane-detach] move failed', error))
      return true
    },
    [detachPaneToNewTab, tabId]
  )
  /** Whether a pane can move now; menus read it only while open, and the move checks it again. */
  const getPaneMoveReadiness = useCallback(
    (paneId: number): PaneMoveReadiness => {
      const manager = managerRef.current
      const leafId = manager?.getLeafId(paneId)
      const transport = paneTransportsRef.current.get(paneId)
      return paneMoveReadiness({
        paneCount: manager?.getPanes().length ?? 0,
        livePtyId: transport?.getPtyId() ?? null,
        persistedPtyId: leafId
          ? useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
          : null,
        sourcePaneCwd: paneCwdRef.current.get(paneId),
        connectPending: transport?.isConnectPending?.() ?? false
      })
    },
    [managerRef, paneCwdRef, paneTransportsRef, tabId]
  )
  /** Moves a pane to a new tab right after this one: the menu, shortcut and palette path. */
  const movePaneToNewTab = useCallback(
    (sourcePaneId: number): void => {
      const target = newTabTargetBesideSource(useAppStore.getState(), worktreeId, tabId)
      if (!target) {
        return
      }
      void detachPaneToNewTab(sourcePaneId, target)
        .then((moved) => moved && focusMovedPane(tabId, moved))
        .catch((error) => console.warn('[terminal-pane-detach] move failed', error))
    },
    [detachPaneToNewTab, tabId, worktreeId]
  )
  // The search palette reaches this tab's active pane through the registry, not a React path.
  useEffect(
    () =>
      registerTerminalPaneUserMoveHandler(worktreeId, tabId, () => {
        const paneId = managerRef.current?.getActivePane()?.id ?? null
        if (paneId === null || getPaneMoveReadiness(paneId) !== 'ready') {
          return false
        }
        movePaneToNewTab(paneId)
        return true
      }),
    [getPaneMoveReadiness, managerRef, movePaneToNewTab, tabId, worktreeId]
  )

  return {
    resolveExternalPaneDropTarget,
    handleExternalPaneDrop,
    detachPaneToNewTab,
    getPaneMoveReadiness,
    movePaneToNewTab
  }
}
