import type { IDisposable, Terminal } from '@xterm/xterm'
import { resetTerminalLinkifierHoverState } from './terminal-linkifier-hover-reset'

export function installTerminalLinkifierHoverResetOnMouseLeave(
  terminal: Terminal,
  linkTooltip?: HTMLElement
): IDisposable {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) {
    return { dispose: () => undefined }
  }

  const resetHover = (): void => {
    if (linkTooltip) {
      linkTooltip.style.display = 'none'
    }
    resetTerminalLinkifierHoverState(terminal)
  }
  // Why: xterm clears its active link but keeps the cell cache on mouseleave.
  screen.addEventListener('mouseleave', resetHover)
  return {
    dispose: () => screen.removeEventListener('mouseleave', resetHover)
  }
}

export function installTerminalLinkifierHoverResetOnWindowBlur(
  terminal: Terminal,
  linkTooltip: HTMLElement
): IDisposable {
  const ownerWindow = linkTooltip.ownerDocument?.defaultView
  if (!ownerWindow) {
    return { dispose: () => undefined }
  }

  const resetHover = (): void => {
    linkTooltip.style.display = 'none'
    resetTerminalLinkifierHoverState(terminal)
  }
  ownerWindow.addEventListener('blur', resetHover)
  return {
    dispose: () => ownerWindow.removeEventListener('blur', resetHover)
  }
}
