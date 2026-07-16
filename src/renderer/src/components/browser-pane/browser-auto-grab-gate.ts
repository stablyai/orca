// Why: the browser repurposes Cmd/Ctrl+C to enter element-grab mode. Callers
// only reach this gate once the opt-in `browserAutoGrabEnabled` setting is on;
// it decides whether this particular keystroke is a grab or a native copy.
export function shouldGrabOnCopyShortcut(args: {
  isEditableTarget: boolean
  markupActive: boolean
  matchesGrabKeybinding: boolean
}): boolean {
  return !args.isEditableTarget && !args.markupActive && args.matchesGrabKeybinding
}
