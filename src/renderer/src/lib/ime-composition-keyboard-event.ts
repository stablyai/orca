import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

// The one place that decides a keystroke belongs to an IME.
// See the IME Composition rules in AGENTS.md before changing any of this.

type ImeCandidateKeyboardEvent = Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>

type AnyKeyboardEvent =
  | ImeCandidateKeyboardEvent
  | Pick<ReactKeyboardEvent, 'nativeEvent'>
  | null
  | undefined

function toNativeKeyboardEvent(event: AnyKeyboardEvent): ImeCandidateKeyboardEvent | null {
  if (!event) {
    return null
  }
  if ('nativeEvent' in event) {
    return (event.nativeEvent as ImeCandidateKeyboardEvent | undefined) ?? null
  }
  return event
}

// Why: browsers do not reliably deliver compositionend when the composing element
// loses focus or leaves the DOM, so the target is kept rather than a bare boolean. Focus loss clears it; unmounting cannot be observed
// that way, because Chromium fires no focusout when a focused node is removed —
// so a live read also revalidates that the target is still connected. Without
// that, one unmount mid-composition would latch this flag on for the session and
// silently kill every Enter-to-commit surface in the app.
let compositionTarget: Node | null = null
let compositionActiveWithoutTarget = false

function setCompositionTarget(target: Node | null): void {
  compositionTarget = target
  compositionActiveWithoutTarget = false
}

function installDocumentCompositionTracking(): void {
  if (typeof document === 'undefined') {
    return
  }
  document.addEventListener(
    'compositionstart',
    (event) => setCompositionTarget(event.target as Node | null),
    true
  )
  document.addEventListener('compositionend', () => setCompositionTarget(null), true)
  document.addEventListener('focusout', () => setCompositionTarget(null), true)
}

installDocumentCompositionTracking()

/** True while any element in the document is mid-composition. */
export function isDocumentImeCompositionActive(): boolean {
  if (compositionActiveWithoutTarget) {
    return true
  }
  if (!compositionTarget) {
    return false
  }
  if (!compositionTarget.isConnected) {
    compositionTarget = null
    return false
  }
  return true
}

export function _setDocumentImeCompositionActiveForTests(active: boolean): void {
  compositionTarget = null
  compositionActiveWithoutTarget = active
}

/**
 * True when an IME owns this keystroke, so the app must not act on it.
 *
 * `keyCode === 229` and `key === 'Process'` are the Windows and Android markers for
 * a key the IME consumed. 229 is also what catches Safari's extra keydown *after*
 * compositionend, where the app-wide flag cannot help because compositionend has
 * already cleared it — the numeric marker is the only bit still set.
 *
 * The flag covers the opposite gap: keys that arrive *during* a live composition
 * carrying neither marker, which is what the per-event bits miss.
 *
 * Call this above the key dispatch, not inside each key branch, so every action
 * (send, history navigation, completion, cancel) is suppressed together.
 *
 * The 229 / 'Process' markers are unconditional here, and deliberately stricter
 * than xterm-bypass-policy.ts, which lets a bare 229 keydown through on
 * macOS/Linux. That is not a contradiction: the terminal needs the keystroke
 * because xterm's CompositionHelper reads the committed glyph off the helper
 * textarea. Callers of this predicate receive committed text through `input`, so
 * a marked keydown carries nothing they could act on — its `key` is 'Process' or
 * 'Unidentified', never the glyph. Suppressing it here costs no input.
 */
export function isImeCompositionKeyDown(event: AnyKeyboardEvent): boolean {
  const nativeEvent = toNativeKeyboardEvent(event)
  if (!nativeEvent) {
    return isDocumentImeCompositionActive()
  }
  if (
    nativeEvent.isComposing === true ||
    nativeEvent.keyCode === 229 ||
    nativeEvent.key === 'Process'
  ) {
    return true
  }
  // Why: an Escape the IME owns is marked above, so an unmarked one means this
  // derived flag has drifted. compositionend is not guaranteed, so swallowing it
  // would strand every cancel path behind a flag nothing is going to clear. Same
  // rule as TERMINAL_IME_OWNED_KEYS in xterm-bypass-policy.ts, which omits Escape
  // for exactly this reason.
  return nativeEvent.key !== 'Escape' && isDocumentImeCompositionActive()
}
