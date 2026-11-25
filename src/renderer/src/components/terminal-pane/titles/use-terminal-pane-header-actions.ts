import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { splitTerminalPaneWithInheritedCwd } from '../layout/split/terminal-pane-split-with-inherited-cwd'
import type { TerminalPaneContextController } from '../controller/use-terminal-pane-context-actions'

export function useTerminalPaneHeaderActions({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  cwd,
  worktreeId,
  tabId
}: Pick<
  TerminalPaneContextController,
  'managerRef' | 'paneTransportsRef' | 'paneCwdRef' | 'cwd' | 'worktreeId' | 'tabId'
>) {
  const activatePaneTitleInteraction = useCallback(
    (paneId: number): void => {
      managerRef.current?.setActivePane(paneId, { focus: false })
    },
    [managerRef]
  )
  const splitTerminalPaneFromHeader = useCallback(
    (pane: ManagedPane, direction: 'vertical' | 'horizontal') => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      splitTerminalPaneWithInheritedCwd({
        worktreeId,
        tabId,
        manager,
        getManager: () => managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneCwdMap: paneCwdRef.current,
        fallbackCwd: cwd ?? '',
        pane,
        direction,
        source: 'context_menu'
      })
    },
    [cwd, managerRef, paneCwdRef, paneTransportsRef, tabId, worktreeId]
  )
  const beginPaneDragFromHeader = useCallback(
    (paneId: number, handle: HTMLElement, event: PointerEvent) => {
      managerRef.current?.beginPaneDragFromPointerDown(paneId, handle, event)
    },
    [managerRef]
  )
  return { activatePaneTitleInteraction, splitTerminalPaneFromHeader, beginPaneDragFromHeader }
}
