import type { Terminal } from '@xterm/xterm'

type TerminalSelectionCopyOptions = {
  terminal: Pick<Terminal, 'getSelection' | 'clearSelection'>
  writeClipboardText: (text: string) => Promise<void>
  clearSelectionOnSuccess?: boolean
}

// Why: route every terminal copy path through one helper so a clipboard write
// failure rejects instead of being swallowed — callers can then withhold their
// "Copied" success UI rather than lying about an unchanged clipboard (#5611).
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
  // Why: only drop the xterm selection once the write resolved, so a failed
  // copy leaves the text selected for the user to retry.
  if (clearSelectionOnSuccess) {
    terminal.clearSelection()
  }
  return true
}
