import type { Terminal } from '@xterm/xterm'

// Terminals saved history was replayed into: what the user sees there is an old session, not a blank pane.
const terminalsWithReplayedHistory = new WeakSet<Terminal>()

export function markTerminalShowsReplayedHistory(terminal: Terminal): void {
  terminalsWithReplayedHistory.add(terminal)
}

export function terminalShowsReplayedHistory(terminal: Terminal): boolean {
  return terminalsWithReplayedHistory.has(terminal)
}
