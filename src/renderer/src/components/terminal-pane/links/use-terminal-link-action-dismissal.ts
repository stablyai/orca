import { useEffect } from 'react'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalLinkActionDismissal({
  closeTerminalLinkActions,
  isActive,
  isRendererVisible,
  paneLayoutRevision
}: Pick<
  TerminalPaneCloseController,
  'closeTerminalLinkActions' | 'isActive' | 'isRendererVisible' | 'paneLayoutRevision'
>): void {
  useEffect(() => {
    closeTerminalLinkActions()
  }, [closeTerminalLinkActions, isActive, isRendererVisible, paneLayoutRevision])
}
