import { useEffect } from 'react'
import { onActiveTerminalPaneCloseRequest } from './request-active-terminal-pane-close'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'

export function useTerminalPaneCloseRequest(
  { tabId, managerRef }: Pick<TerminalPaneBindingController, 'tabId' | 'managerRef'>,
  requestClose: (paneId: number) => void
): void {
  useEffect(
    () =>
      onActiveTerminalPaneCloseRequest(tabId, (leafId) => {
        const manager = managerRef.current
        const pane = leafId
          ? manager?.getPanes().find((candidate) => manager.getLeafId(candidate.id) === leafId)
          : (manager?.getActivePane() ?? manager?.getPanes()[0])
        if (pane) {
          requestClose(pane.id)
        }
      }),
    [tabId, managerRef, requestClose]
  )
}
