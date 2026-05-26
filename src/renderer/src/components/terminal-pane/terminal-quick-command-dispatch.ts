import type { TerminalQuickCommand } from '../../../../shared/types'
import { buildTerminalQuickCommandInput } from '../../../../shared/terminal-quick-commands'
import { pasteTerminalText } from './terminal-bracketed-paste'

type QuickCommandPane = {
  terminal: {
    focus: () => void
    modes: {
      bracketedPasteMode: boolean
    }
    options: {
      ignoreBracketedPasteMode?: boolean
    }
    paste: (text: string) => void
  }
}

type QuickCommandTransport = {
  sendInput: (data: string) => boolean
}

const LINE_BREAK_RE = /[\r\n]/

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

  if (LINE_BREAK_RE.test(command.command)) {
    // Why: sending multiline quick commands as raw queued PTY input lets a
    // foreground command consume later lines before the shell sees them.
    pasteTerminalText(pane.terminal, command.command)
    const sent = command.appendEnter ? transport.sendInput('\r') : true
    if (sent) {
      pane.terminal.focus()
    }
    return sent
  }

  const sent = transport.sendInput(buildTerminalQuickCommandInput(command))
  if (sent) {
    pane.terminal.focus()
  }
  return sent
}
