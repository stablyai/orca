import type { IDisposable, Terminal } from '@xterm/xterm'
import { resetTerminalLinkifierHoverState } from './terminal-linkifier-hover-reset'

export function installTerminalLinkifierHoverResetOnMouseLeave(terminal: Terminal): IDisposable {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) {
    return { dispose: () => undefined }
  }

  const resetHover = (): void => resetTerminalLinkifierHoverState(terminal)
  // Why: xterm clears its active link but keeps the cell cache on mouseleave.
  screen.addEventListener('mouseleave', resetHover)
  return {
    dispose: () => screen.removeEventListener('mouseleave', resetHover)
  }
}
