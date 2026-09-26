import type { IDisposable, Terminal } from '@xterm/xterm'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'

type TerminalSelectionCopyTarget = Pick<Terminal, 'getSelection'> & {
  element?: HTMLElement
}

export function installTerminalSelectionCopyHandler(
  terminal: TerminalSelectionCopyTarget,
  writeClipboardText: (text: string) => Promise<void>
): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => {} }
  }

  const onCopy = (event: ClipboardEvent): void => {
    const selection = readTerminalClipboardSelection(terminal)
    if (!selection || !event.clipboardData) {
      return
    }
    event.clipboardData.setData('text/plain', selection)
    event.preventDefault()
    event.stopImmediatePropagation()
    void writeClipboardText(selection).catch(() => {})
  }
  element.addEventListener('copy', onCopy, { capture: true })
  return { dispose: () => element.removeEventListener('copy', onCopy, { capture: true }) }
}
