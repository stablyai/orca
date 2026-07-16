// Why: the browser repurposes Cmd/Ctrl+C to enter element-grab mode. This gate
// keeps that hijack behind the opt-in `browserAutoGrabEnabled` setting so the
// copy gesture stays native until the user turns Auto Grab on.
export function shouldGrabOnCopyShortcut(args: {
  autoGrabEnabled: boolean
  isEditableTarget: boolean
  markupActive: boolean
  matchesGrabKeybinding: boolean
}): boolean {
  return (
    !args.isEditableTarget &&
    args.autoGrabEnabled &&
    !args.markupActive &&
    args.matchesGrabKeybinding
  )
}
