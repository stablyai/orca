import type { IDisposable, Terminal } from '@xterm/xterm'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'

const CAPTURE_LISTENER_OPTIONS = { capture: true } as const

export function installTerminalLinkPtyMouseSuppression(
  terminal: Terminal,
  shouldSuppressMouseEvent: (event: MouseEvent) => boolean,
  // Why a getter, not a snapshot: applyTerminalAppearance owns this option and can
  // rewrite it mid-gesture, so restoring a saved value would strand the pane.
  getMouseEventsRequireAlt: () => boolean = () => false
): IDisposable {
  const terminalElement = terminal.element
  const ownerDocument = terminalElement?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  let suppressing = false
  let restoreQueued = false

  const restore = (): void => {
    restoreQueued = false
    if (!suppressing) {
      return
    }
    terminal.options.mouseEventsRequireAlt = getMouseEventsRequireAlt()
    suppressing = false
    ownerDocument?.removeEventListener('mouseup', queueRestore)
    ownerWindow?.removeEventListener('blur', restore)
  }
  const queueRestore = (): void => {
    if (restoreQueued || !suppressing) {
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
    suppressing = true
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
