import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
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
    modes?: {
      bracketedPasteMode?: boolean
    }
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
    buildTerminalQuickCommandInput(
      flattenTerminalQuickCommand(command),
      pane.terminal.modes?.bracketedPasteMode === true
    )
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}
