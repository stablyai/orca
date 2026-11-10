import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { UseTerminalPaneContextMenuDeps } from '../context-menu/terminal-pane-context-menu-types'

export function createTerminalPaneMenuTitleActions({
  onSetTitle,
  onClearPaneTitle,
  resolveMenuPane
}: Pick<UseTerminalPaneContextMenuDeps, 'onSetTitle' | 'onClearPaneTitle'> & {
  resolveMenuPane: () => ManagedPane | null
}) {
  /** Routes title edits through the resolved menu pane instead of active pane. */
  const handleSetTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onSetTitle(pane.id)
    }
  }

  /** Clears the title for the pane that opened the context menu. */
  const handleClearPaneTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneTitle(pane.id)
    }
  }
  return { handleSetTitle, handleClearPaneTitle }
}
