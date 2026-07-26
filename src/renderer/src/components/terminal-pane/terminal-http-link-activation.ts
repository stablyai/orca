import { isTerminalLinkActivation } from './terminal-link-activation'

export function isTerminalHttpLinkActivation(event: MouseEvent | undefined): boolean {
  // Why: xterm deliberately forwards Alt-modified mouse gestures to the PTY,
  // so plain HTTP link handling must leave those gestures to the child TUI.
  return Boolean(event && !event.altKey && isTerminalLinkActivation(event))
}
