import type { TerminalQuickCommand } from '../../../../shared/types'
import {
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'

type QuickCommandPane = {
  leafId: string
  terminal: {
    focus: () => void
  }
}

type QuickCommandTransport = {
  sendInput: (data: string) => boolean
}

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
    buildTerminalQuickCommandInput(flattenTerminalQuickCommand(command))
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}
