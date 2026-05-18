import type { TerminalQuickCommand } from '../../../../shared/types'
import { buildTerminalQuickCommandInput } from '../../../../shared/terminal-quick-commands'

type QuickCommandPane = {
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
  transport
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  transport: QuickCommandTransport | null | undefined
}): boolean {
  if (!transport) {
    return false
  }

  const sent = transport.sendInput(buildTerminalQuickCommandInput(command))
  if (sent) {
    pane.terminal.focus()
  }
  return sent
}
