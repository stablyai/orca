import { createPortal } from 'react-dom'
import { useIsTabPoppedOut } from '@/lib/workspace-popout/workspace-popout-state'
import { TerminalPopoutOverlay } from './TerminalPopoutOverlay'
import type { TerminalPaneController } from '../controller/use-terminal-pane-controller'

export function TerminalPanePopoutPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { managedPanes, tabId, worktreeId } = controller
  const isPoppedOut = useIsTabPoppedOut(tabId)

  if (!isPoppedOut) {
    return null
  }

  return (
    <>
      {managedPanes.map((pane) =>
        createPortal(
          <TerminalPopoutOverlay key={`popout-${pane.id}`} worktreeId={worktreeId} tabId={tabId} />,
          pane.container,
          `popout-pane-${pane.id}`
        )
      )}
    </>
  )
}
