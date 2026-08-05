// Why: writeClipboardText resolved unconditionally in the web client until the
// insecure-context copy fallback landed. It can now reject (insecure origin with
// no live user gesture), so these two menu actions need explicit outcomes:
// the copy must never leave the pane unfocused, and Copy Pane ID must not toast
// success for a copy that did not happen. Extracted so both are testable without
// mounting the whole context-menu hook.

export async function runTerminalCopy(args: {
  selection: string
  writeClipboardText: (text: string) => Promise<void>
  focus: () => void
  onError?: (error: unknown) => void
}): Promise<void> {
  try {
    if (args.selection) {
      await args.writeClipboardText(args.selection)
    }
  } catch (error) {
    // Why surface: a failed copy currently produces no user feedback, leading
    // to "Copy does nothing / shows copied but clipboard is empty" confusion.
    // Callers that want a toast pass onError; otherwise log so it's not silent.
    if (args.onError) {
      args.onError(error)
    } else {
      console.error('Terminal copy failed:', error)
    }
  } finally {
    args.focus()
  }
}

export async function runCopyPaneId(args: {
  paneKey: string
  writeClipboardText: (text: string) => Promise<void>
  onSuccess: () => void
  onError: () => void
  focus: () => void
}): Promise<void> {
  try {
    await args.writeClipboardText(args.paneKey)
    args.onSuccess()
  } catch {
    args.onError()
  } finally {
    args.focus()
  }
}
