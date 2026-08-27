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
  }
}

type QuickCommandTransport = {
  sendInput: (data: string) => boolean
  sendQuickCommand?: (data: string) => Promise<boolean>
}

export async function sendTerminalQuickCommandToPane({
  command,
  pane,
  tabId,
  transport
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
}): Promise<boolean> {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  const flattened = flattenTerminalQuickCommand(command)
  const input = buildTerminalQuickCommandInput(flattened)
  const sentPromise = flattened.appendEnter
    ? (transport.sendQuickCommand?.(input) ?? Promise.resolve(false))
    : Promise.resolve(transport.sendInput(input))
  if (flattened.appendEnter) {
    // Keep the menu action responsive while the owning runtime waits for a TUI composer barrier.
    pane.terminal.focus()
  }
  let sent = false
  try {
    sent = await sentPromise
  } catch {
    return false
  }
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    if (!flattened.appendEnter) {
      pane.terminal.focus()
    }
  }
  return sent
}
