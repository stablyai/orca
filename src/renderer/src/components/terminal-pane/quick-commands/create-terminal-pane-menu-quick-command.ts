import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import { runQuickCommandInNewTab } from '@/lib/terminal/quick-commands/run-quick-command-in-new-tab'
import type { UseTerminalPaneContextMenuDeps } from '../context-menu/terminal-pane-context-menu-types'

export function createTerminalPaneMenuQuickCommand({
  paneTransportsRef,
  tabId,
  worktreeId,
  groupId,
  resolveMenuPane,
  resolveArguments
}: Pick<
  UseTerminalPaneContextMenuDeps,
  'paneTransportsRef' | 'tabId' | 'worktreeId' | 'groupId'
> & {
  resolveMenuPane: () => ManagedPane | null
  resolveArguments: (command: TerminalQuickCommand) => Promise<TerminalQuickCommand | null>
}) {
  const onQuickCommand = async (
    savedCommand: TerminalQuickCommand,
    historyId: string
  ): Promise<void> => {
    // Why: resolve the pane before awaiting; the argument prompt closes the menu that pins it.
    const pane = resolveMenuPane()
    const command = await resolveArguments(savedCommand)
    if (!command) {
      return
    }
    if (isTerminalAgentQuickCommand(command)) {
      runQuickCommandInNewTab({ command, worktreeId, groupId, historyId })
      return
    }
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
