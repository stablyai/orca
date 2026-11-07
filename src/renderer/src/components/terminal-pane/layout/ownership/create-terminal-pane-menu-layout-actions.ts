import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { equalizeTerminalPanes } from './terminal-pane-layout-owner-commands'
import type { UseTerminalPaneContextMenuDeps } from '../../context-menu/terminal-pane-context-menu-types'

export function createTerminalPaneMenuLayoutActions({
  managerRef,
  tabId,
  worktreeId,
  onRequestClosePane,
  resolveMenuPane
}: Pick<
  UseTerminalPaneContextMenuDeps,
  'managerRef' | 'tabId' | 'worktreeId' | 'onRequestClosePane'
> & { resolveMenuPane: () => ManagedPane | null }) {
  const onEqualizePaneSizes = (): void => {
    const pane = resolveMenuPane()
    const manager = managerRef.current
    if (!pane || !manager) {
      return
    }
    equalizeTerminalPanes({ worktreeId, tabId, getManager: () => managerRef.current }, () =>
      pane.terminal.focus()
    )
  }

  const onClosePane = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onRequestClosePane(pane.id)
    }
  }
  return { onEqualizePaneSizes, onClosePane }
}
