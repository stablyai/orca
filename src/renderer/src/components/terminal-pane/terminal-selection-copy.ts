import type { Terminal } from '@xterm/xterm'

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
  const selection = terminal.getSelection()
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
