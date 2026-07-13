import type { IDisposable, Terminal } from '@xterm/xterm'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'

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
    if (
      event.button !== 0 ||
      !isTerminalHttpLinkActivation(event) ||
      !shouldSuppressMouseEvent(event)
    ) {
      return
    }
    restore()
    previousMouseEventsRequireAlt = Boolean(terminal.options.mouseEventsRequireAlt)
    // Why: xterm otherwise forwards the same Cmd/Ctrl link gesture to a mouse-aware
    // TUI, letting the terminal and the child process both open the URL.
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
