import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from '../terminal-quick-command-dispatch'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { UseTerminalPaneContextMenuDeps } from '../context-menu/terminal-pane-context-menu-types'

export function createTerminalPaneMenuQuickCommand({
  paneTransportsRef,
  tabId,
  worktreeId,
  groupId,
  resolveMenuPane
}: Pick<
  UseTerminalPaneContextMenuDeps,
  'paneTransportsRef' | 'tabId' | 'worktreeId' | 'groupId'
> & { resolveMenuPane: () => ManagedPane | null }) {
  const onQuickCommand = (command: TerminalQuickCommand, historyId: string): void => {
    if (isTerminalAgentQuickCommand(command)) {
      runQuickCommandInNewTab({ command, worktreeId, groupId, historyId })
      return
    }

    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    sendTerminalQuickCommandToPane({
      command,
      pane,
      tabId,
      transport: paneTransportsRef.current.get(pane.id)
    })
  }
  return { onQuickCommand }
}
