// Why: writeClipboardText resolved unconditionally in the web client until the
// insecure-context copy fallback landed. It can now reject (insecure origin with
// no live user gesture), so identity-copy actions need explicit outcomes:
// the copy must never leave the pane unfocused, and identity actions must not toast
// success for a copy that did not happen. Extracted so both are testable without
// mounting the whole context-menu hook.

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
    // Why swallow: matches the shortcut and copy-on-select paths, and a failed
    // copy must not cost the pane its input focus.
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
