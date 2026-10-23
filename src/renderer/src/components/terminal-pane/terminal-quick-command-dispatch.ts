import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import type { PtyTransport } from './pty-transport-types'

type QuickCommandPane = {
  leafId: string
  terminal: {
    focus: () => void
    modes: { bracketedPasteMode: boolean }
  }
}

type QuickCommandTransport = Pick<PtyTransport, 'sendInput'>

export function sendTerminalQuickCommandToPane({
  command,
  pane,
  tabId,
  transport,
  onError
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
  onError: (message: string) => void
}): boolean {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  if (/[\r\n]/.test(command.command) && !pane.terminal.modes.bracketedPasteMode) {
    onError(
      'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
    )
    return false
  }

  const sent = transport.sendInput(
    buildTerminalQuickCommandInput(command, {
      bracketedPasteSafe: pane.terminal.modes.bracketedPasteMode
    }),
    'driving'
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}
