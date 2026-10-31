import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import type { PtyTransport } from './pty-transport-types'

type QuickCommandPane = {
  leafId: string
  terminal: {
    focus: () => void
  }
}

type QuickCommandTransport = Pick<PtyTransport, 'sendInput'>

export function sendTerminalQuickCommandToPane({
  command,
  pane,
  tabId,
  transport
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
}): boolean {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  const sent = transport.sendInput(
    buildTerminalQuickCommandInput(flattenTerminalQuickCommand(command)),
    'driving'
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}

/** Context-menu run: agent prompts open a new tab; terminal commands type into the clicked pane. */
export function runTerminalPaneQuickCommand({
  command,
  historyId,
  pane,
  tabId,
  worktreeId,
  groupId,
  paneTransportsRef
}: {
  command: TerminalQuickCommand
  historyId: string
  pane: (QuickCommandPane & { id: number }) | null
  tabId: string
  worktreeId: string
  groupId: string | null | undefined
  paneTransportsRef: { current: Map<number, QuickCommandTransport> }
}): void {
  if (isTerminalAgentQuickCommand(command)) {
    runQuickCommandInNewTab({ command, worktreeId, groupId, historyId })
    return
  }
  if (pane) {
    sendTerminalQuickCommandToPane({
      command,
      pane,
      tabId,
      transport: paneTransportsRef.current.get(pane.id)
    })
  }
}
