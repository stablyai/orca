import type { IDisposable, Terminal } from '@xterm/xterm'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'

type NativeCopyTerminal = Pick<Terminal, 'getSelection' | 'hasSelection'> & {
  element?: HTMLElement
}

/** Capture native copy before xterm writes raw cells; unbound browser accelerators such as Windows/Linux Ctrl+Insert otherwise retain the agent gutter (#19770). */
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
