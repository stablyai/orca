import type { Terminal } from '@xterm/xterm'

export type TerminalScrollbackPaneManager = {
  getPanes(): { terminal: Pick<Terminal, 'options'> }[]
}

export function applyTerminalScrollbackRowsToMountedPanes(
  manager: TerminalScrollbackPaneManager,
  rows: number
): void {
  for (const pane of manager.getPanes()) {
    if (pane.terminal.options.scrollback !== rows) {
      pane.terminal.options.scrollback = rows
    }
  }
}
