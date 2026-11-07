import { useCallback } from 'react'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import type { PaneProcessExit } from './pane-process-exit'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'

export function useExitedPaneActions({
  executeClosePane,
  setPaneProcessExitsByPaneId,
  handleRestartPane
}: Pick<TerminalPaneCloseController, 'executeClosePane' | 'setPaneProcessExitsByPaneId'> & {
  handleRestartPane: ReturnType<typeof usePaneProcessRestart>['handleRestartPane']
}) {
  const clearPaneProcessExit = useCallback(
    (paneId: number) => {
      setPaneProcessExitsByPaneId((current) => {
        if (current[paneId] === undefined) {
          return current
        }
        const next = { ...current }
        delete next[paneId]
        return next
      })
    },
    [setPaneProcessExitsByPaneId]
  )

  const handleRestartExitedPane = useCallback(
    (processExit: PaneProcessExit) => {
      clearPaneProcessExit(processExit.paneId)
      // Why no agent fallback: a null startup means a plain shell; account switches restart via their own path.
      handleRestartPane(processExit.paneId, resolveTerminalProcessExitRestartStartup(processExit), {
        focus: true
      })
    },
    [clearPaneProcessExit, handleRestartPane]
  )

  const handleCloseExitedPane = useCallback(
    (paneId: number) => {
      clearPaneProcessExit(paneId)
      executeClosePane(paneId, 'user')
    },
    [clearPaneProcessExit, executeClosePane]
  )
  return { handleRestartExitedPane, handleCloseExitedPane }
}
