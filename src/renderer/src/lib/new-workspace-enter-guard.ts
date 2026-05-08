/**
 * Returns true when an Enter keydown event should be suppressed for submit actions.
 *
 * Two cases must be blocked:
 *  1. IME composition is active — Enter only confirms the conversion candidate.
 *  2. Shift+Enter inside a textarea — intended as a newline, not a submit.
 */
export function shouldSuppressEnterSubmit(
  event: { isComposing: boolean; shiftKey: boolean },
  isTextarea: boolean
): boolean {
  if (event.isComposing) {
    return true
  }
  if (isTextarea && event.shiftKey) {
    return true
  }
  return false
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
  // Why: selecting a PR/issue/Linear row replaces the focused input with a
  // source pill, and Chromium can retarget the next global keydown to body.
  // Keep the modal shortcut alive for that post-selection focus fallback.
  return target === document.body || target === document.documentElement
}
