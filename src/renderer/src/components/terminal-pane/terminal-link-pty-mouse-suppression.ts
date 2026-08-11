import type { IDisposable, Terminal } from '@xterm/xterm'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'

const CAPTURE_LISTENER_OPTIONS = { capture: true } as const

export function installTerminalLinkPtyMouseSuppression(
  terminal: Terminal,
  shouldSuppressMouseEvent: (event: MouseEvent) => boolean
): IDisposable {
  const terminalElement = terminal.element
  const ownerDocument = terminalElement?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  let previousMouseEventsRequireAlt: boolean | null = null
  let restoreQueued = false

  const restore = (): void => {
    restoreQueued = false
    if (previousMouseEventsRequireAlt === null) {
      return
    }
    terminal.options.mouseEventsRequireAlt = previousMouseEventsRequireAlt
    previousMouseEventsRequireAlt = null
    ownerDocument?.removeEventListener('mouseup', queueRestore)
    ownerWindow?.removeEventListener('blur', restore)
  }
  const queueRestore = (): void => {
    if (restoreQueued || previousMouseEventsRequireAlt === null) {
      return
    }
    restoreQueued = true
    queueMicrotask(restore)
  }
  const handleMouseDown = (event: MouseEvent): void => {
    if (!isTerminalLinkDirectActivation(event) || !shouldSuppressMouseEvent(event)) {
      return
    }
    restore()
    previousMouseEventsRequireAlt = Boolean(terminal.options.mouseEventsRequireAlt)
    // Why: an Orca-owned link gesture must not also reach a mouse-aware child TUI.
    terminal.options.mouseEventsRequireAlt = true
    ownerDocument?.addEventListener('mouseup', queueRestore)
    ownerWindow?.addEventListener('blur', restore)
  }

  terminalElement?.addEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
  terminalElement?.addEventListener('mouseup', queueRestore, CAPTURE_LISTENER_OPTIONS)
  return {
    dispose: () => {
      restore()
      terminalElement?.removeEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
      terminalElement?.removeEventListener('mouseup', queueRestore, CAPTURE_LISTENER_OPTIONS)
    }
  }
}
