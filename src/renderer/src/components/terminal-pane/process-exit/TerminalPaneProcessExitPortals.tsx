import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import type { TerminalPaneController } from '../controller/use-terminal-pane-controller'

const TerminalProcessExitOverlay = lazy(() =>
  import('./TerminalProcessExitOverlay').then((module) => ({
    default: module.TerminalProcessExitOverlay
  }))
)

export function TerminalPaneProcessExitPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    handleCloseExitedPane,
    handleRestartExitedPane,
    isActive,
    managedPanes,
    paneProcessExitsByPaneId
  } = controller
  if (!isActive) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) => {
        const processExit = paneProcessExitsByPaneId[pane.id]
        if (!processExit) {
          return null
        }
        return createPortal(
          <Suspense fallback={null}>
            <TerminalProcessExitOverlay
              processExit={processExit}
              onRestart={() => handleRestartExitedPane(processExit)}
              onClose={() => handleCloseExitedPane(pane.id)}
            />
          </Suspense>,
          pane.container,
          `process-exit-${pane.id}`
        )
      })}
    </>
  )
}
