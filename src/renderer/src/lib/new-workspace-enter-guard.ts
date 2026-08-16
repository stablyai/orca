export function shouldSuppressEnterSubmit(
  event: { isComposing: boolean; shiftKey: boolean },
  isTextarea: boolean
): boolean {
  return event.isComposing || (isTextarea && event.shiftKey)
}

export function shouldAllowComposerEnterSubmitTarget(
  target: EventTarget | null,
  composer: HTMLElement | null
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (composer?.contains(target)) {
    return true
  }
  // Why: selecting a PR/issue/Linear row tears down the focused input and
  // Radix's focus restore can land on body/documentElement, the DialogContent
  // root, or any other ancestor wrapping the composer. Allow any ancestor so
  // the modal's Cmd/Ctrl+Enter shortcut keeps firing post-selection.
  return composer ? target.contains(composer) : false
}
