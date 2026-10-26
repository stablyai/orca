import { useCallback } from 'react'
import { useAppStore } from '../../store'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'
import { retireUnboundRuntimeTerminalPane } from './retire-unbound-runtime-terminal-pane'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-terminal-actions'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import { retireUnboundIpcTerminalPane } from './retire-unbound-ipc-terminal-pane'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import { noteAgentLaunchPaneClosedByUser } from '@/lib/agent-launch-pane-closes'

export function useTerminalPaneLocalClose(controller: TerminalPaneBindingController) {
  const {
    clearSessionRestoredBannerForPane,
    managerRef,
    onCloseTab,
    paneTransportsRef,
    setTerminalErrorsByPaneId,
    syncPanePtyLayoutBinding,
    syncPanePtyLayoutBindingForLeaf,
    tabId,
    worktreeId
  } = controller
  // The window's half of a split pane's close: its transport, status and pane go.
  const closePaneLocally = useCallback(
    (paneId: number, committedLeafId?: string) => {
      const manager = managerRef.current
      // Why the pane check: main's answer can land after the pane already went.
      if (!manager || (committedLeafId && manager.getLeafId(paneId) !== committedLeafId)) {
        return
      }
      // A sibling went while main answered: this pane is now the tab's last, so the tab closes.
      if (committedLeafId && manager.getPanes().length <= 1) {
        onCloseTab()
        return
      }
      const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
      closeWebRuntimeTerminal(ptyId, worktreeId)
      clearSessionRestoredBannerForPane(paneId)
      const leafId = manager.getLeafId(paneId)
      if (leafId) {
        const launchPane = useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.agentLaunchPane
        if (launchPane?.leafId === leafId && !launchPane.outcome) {
          // The user closed a launch pane whose agent is still starting; main stops that launch.
          noteAgentLaunchPaneClosedByUser(tabId, leafId)
        }
        if (!committedLeafId) {
          commitTerminalSurfaceClose(worktreeId, { kind: 'pane', tabId, leafId })
        }
        retireUnboundIpcTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
        useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId), { paneRemoved: true })
      }
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      if (leafId) {
        retireUnboundRuntimeTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
      } else {
        syncPanePtyLayoutBinding(paneId, null)
      }
      manager.closePane(paneId)
    },
    [
      clearSessionRestoredBannerForPane,
      onCloseTab,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      tabId,
      worktreeId,
      managerRef,
      paneTransportsRef,
      setTerminalErrorsByPaneId
    ]
  )
  return closePaneLocally
}
