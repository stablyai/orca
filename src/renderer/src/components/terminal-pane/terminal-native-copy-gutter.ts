import type { IDisposable, Terminal } from '@xterm/xterm'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'

type NativeCopyTerminal = Pick<Terminal, 'getSelection' | 'hasSelection'> & {
  element?: HTMLElement
}

/**
 * xterm binds its own DOM `copy` listener that writes raw screen cells
 * (CoreBrowserTerminal `_initGlobal`). Native copy, including Wayland user copies
 * routed through Electron, must trim the same gutter as IPC copies (#19770).
 * Capture phase, so this wins when the event targets the helper textarea and
 * xterm's element-level listener is next in line.
 */
export function installTerminalNativeCopyGutterTrim(terminal: NativeCopyTerminal): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => {} }
  }
  const onCopy = (event: ClipboardEvent): void => {
    if (!terminal.hasSelection() || !event.clipboardData) {
      return
    }
    event.clipboardData.setData('text/plain', readTerminalClipboardSelection(terminal))
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  element.addEventListener('copy', onCopy, { capture: true })
  return { dispose: () => element.removeEventListener('copy', onCopy, { capture: true }) }
}
