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
  // Selection teardown can restore focus to any composer ancestor; accept those targets so Cmd/Ctrl+Enter still submits.
  return composer ? target.contains(composer) : false
}
