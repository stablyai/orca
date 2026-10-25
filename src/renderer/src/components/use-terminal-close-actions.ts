import { useCallback } from 'react'
import { useAppStore } from '../store'
import { isProvenProcessExit } from '../../../shared/terminal-exit-cause'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { shouldDeferParkedPtyExitTabClose } from './terminal-pane/terminal-parked-tab-watchers'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import type { TerminalCreateController } from './use-terminal-create-actions'

export function useTerminalCloseActions(controller: TerminalCreateController) {
  const { consumeSuppressedPtyExit } = controller
  const handleCloseTab = useCallback((tabId: string) => {
    closeTerminalTab(tabId)
  }, [])

  const handleCloseBrowserTab = useCallback((tabId: string) => {
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'browser-source', sourceId: tabId }
    })
  }, [])

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string, exitCode?: number) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      // Negative exit codes mean host loss, not process exit; retain the tab for reconnect/reveal recovery.
      if (exitCode !== undefined && !isProvenProcessExit(exitCode)) {
        useAppStore.getState().markUnverifiedPtyLoss(tabId)
        return
      }
      // Parked splits have no PaneManager to promote siblings; defer dead-leaf handling to reveal/remount instead of killing them.
      if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTerminalTab(tabId, { reason: 'pty-exit', lifecyclePtyId: ptyId })
    },
    [consumeSuppressedPtyExit]
  )

  return { handleCloseTab, handleCloseBrowserTab, handlePtyExit }
}

export type TerminalCloseController = TerminalCreateController &
  ReturnType<typeof useTerminalCloseActions>
