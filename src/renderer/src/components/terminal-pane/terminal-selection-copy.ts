import type { Terminal } from '@xterm/xterm'
import { copySelectedTextFromUserInput } from '@/lib/copy-selected-text-from-user-input'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'

type TerminalSelectionCopyOptions = {
  terminal: Pick<Terminal, 'getSelection' | 'clearSelection'>
  writeClipboardText: (text: string) => Promise<void>
  clearSelectionOnSuccess?: boolean
}

/** Publishes selected terminal text, clearing the selection only after a successful write. */
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

/** Copies a terminal selection without moving focus during automatic selection changes. */
export function copyTerminalSelectionFromUserInput(
  terminal: Pick<Terminal, 'getSelection' | 'focus' | 'textarea'>,
  source: 'keyboard' | 'selection'
): Promise<void> {
  const textarea = terminal.textarea
  return copySelectedTextFromUserInput({
    text: readTerminalClipboardSelection(terminal),
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
    // Search also changes the selection; automatic copy must never move focus.
    allowNativeCopy:
      source === 'keyboard' ||
      (textarea !== undefined && textarea.ownerDocument.activeElement === textarea),
    beforeNativeCopy: source === 'keyboard' ? () => terminal.focus() : undefined
  })
}
