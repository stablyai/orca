import type { Terminal } from '@xterm/xterm'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'

type TerminalSelectionCopyOptions = {
  terminal: Pick<Terminal, 'getSelection' | 'clearSelection'>
  writeClipboardText: (text: string) => Promise<void>
  clearSelectionOnSuccess?: boolean
}

export async function copyTerminalSelection({
  terminal,
  writeClipboardText,
  clearSelectionOnSuccess = false
}: TerminalSelectionCopyOptions): Promise<boolean> {
  const selection = readTerminalClipboardSelection(terminal)
  if (!selection) {
    return false
  }

  await writeClipboardText(selection)
  // Keep failed-copy text selected for retry.
  if (clearSelectionOnSuccess) {
    terminal.clearSelection()
  }
  return true
}
