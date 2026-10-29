// Clipboard writes can reject on insecure web origins; always restore input focus and report success only after a completed copy.

export async function runTerminalCopy(args: {
  selection: string
  writeClipboardText: (text: string) => Promise<void>
  focus: () => void
}): Promise<void> {
  try {
    if (args.selection) {
      await args.writeClipboardText(args.selection)
    }
  } catch {
    // Match shortcut/copy-on-select behavior: failed copy must still restore pane focus.
  } finally {
    args.focus()
  }
}

export async function runTerminalIdentityCopy(args: {
  text: string
  writeClipboardText: (text: string) => Promise<void>
  onSuccess: () => void
  onError: () => void
  focus: () => void
}): Promise<void> {
  try {
    await args.writeClipboardText(args.text)
    args.onSuccess()
  } catch {
    args.onError()
  } finally {
    args.focus()
  }
}
