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
      // A negative code is the host-loss sentinel, not proof that the remote
      // process exited. Keep the mounted tab for reconnect/reveal to recover.
      if (exitCode !== undefined && !isProvenProcessExit(exitCode)) {
        useAppStore.getState().markUnverifiedPtyLoss(tabId)
        return
      }
      // Why: a parked multi-leaf tab has no PaneManager to promote split siblings, so closing here would kill them; reveal-remount handles dead PTYs per leaf.
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
