import { isImeCompositionKeyDown } from './ime-composition-keyboard-event'

/**
 * Returns true when an Enter keydown event should be suppressed for submit actions.
 *
 * Two cases must be blocked:
 *  1. IME composition is active — Enter only confirms the conversion candidate.
 *  2. Shift+Enter inside a textarea — intended as a newline, not a submit.
 */
export function shouldSuppressEnterSubmit(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode' | 'shiftKey'>,
  isTextarea: boolean
): boolean {
  // Delegates so these gates get the 229 / 'Process' markers and the live-composition
  // flag too; bare isComposing misses an IME-owned Enter on Windows and Android.
  if (isImeCompositionKeyDown(event)) {
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
  // Why: selecting a PR/issue/Linear row tears down the focused input and
  // Radix's focus restore can land on body/documentElement, the DialogContent
  // root, or any other ancestor wrapping the composer. Allow any ancestor so
  // the modal's Cmd/Ctrl+Enter shortcut keeps firing post-selection.
  return composer ? target.contains(composer) : false
}
