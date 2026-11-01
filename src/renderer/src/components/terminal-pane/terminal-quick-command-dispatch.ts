import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { prepareTerminalQuickCommandForRun } from '@/lib/terminal-quick-command-placeholder-run'
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
  worktreeId,
  transport
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  worktreeId: string
  transport: QuickCommandTransport | null | undefined
}): boolean {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }
  const prepared = prepareTerminalQuickCommandForRun(command, worktreeId)
  if (!prepared) {
    return false
  }

  const sent = transport.sendInput(
    buildTerminalQuickCommandInput(flattenTerminalQuickCommand(prepared)),
    'driving'
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}
