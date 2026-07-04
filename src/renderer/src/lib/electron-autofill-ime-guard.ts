// Why: Electron's autofill agent sends ShowAutofillPopup with an empty
// suggestion list whenever an editable's value changes with the caret at the
// value end — during IME composition that is every keystroke — and the browser
// process destroys and recreates a native popup NSWindow each time. On
// macOS 26 every rebuild blocks the browser main thread (the route for ALL
// input events) on a synchronous WindowServer transaction for 50–350ms, felt
// as app-wide typing jank while composing Japanese/Chinese/Korean. Until the
// Electron fix ships, keep a zero-width sentinel after the caret for the
// duration of a composition so the agent's caret-at-end check fails and only
// its cheap hide path runs. Plain (non-IME) typing never arms the guard.

export const AUTOFILL_IME_GUARD_SENTINEL = '\u200b'

const IME_PROCESS_KEY_CODE = 229

type GuardableField = HTMLInputElement | HTMLTextAreaElement

// Input types that both support setSelectionRange and can host an IME
// composition. Others (email/number/password/…) throw on selection APIs or
// do not compose.
const GUARDABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel'])

export function resolveAutofillGuardableField(target: unknown): GuardableField | null {
  if (target instanceof HTMLTextAreaElement) {
    // Why: Monaco drives its hidden textarea with its own value diffing and a
    // mid-value caret (already immune); a foreign sentinel corrupts its state.
    // xterm's helper textarea is deliberately guardable — its CompositionHelper
    // extracts committed text by position and strips pre-existing suffixes.
    if (target.classList.contains('inputarea')) {
      return null
    }
    return target.readOnly || target.disabled ? null : target
  }
  if (target instanceof HTMLInputElement) {
    if (!GUARDABLE_INPUT_TYPES.has((target.type || 'text').toLowerCase())) {
      return null
    }
    return target.readOnly || target.disabled ? null : target
  }
  return null
}

function setFieldValueSyncedWithReact(field: GuardableField, value: string): void {
  // Why: React shadows the value property on controlled fields; write through
  // the prototype setter and emit a bubbling input event so component state
  // resynchronizes and no sentinel survives in application state.
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(field, value)
  } else {
    field.value = value
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function clampSelection(index: number | null, max: number): number {
  return Math.max(0, Math.min(index ?? max, max))
}

export type ElectronAutofillImeGuard = {
  dispose: () => void
}

export function installElectronAutofillImeGuard(
  root: Document | HTMLElement = document
): ElectronAutofillImeGuard {
  let composing = false

  const arm = (field: GuardableField): void => {
    if (field.value.endsWith(AUTOFILL_IME_GUARD_SENTINEL)) {
      return
    }
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    // Why: direct assignment (no synthetic event) — the sentinel must be
    // invisible to application code while it exists; React resyncs from the
    // user's next real input event, and strip() emits the corrective event.
    field.value = field.value + AUTOFILL_IME_GUARD_SENTINEL
    const max = field.value.length - 1
    try {
      field.setSelectionRange(clampSelection(start, max), clampSelection(end, max))
    } catch {
      /* ignore — selection APIs can reject on exotic field states */
    }
  }

  const strip = (field: GuardableField): void => {
    if (!field.value.endsWith(AUTOFILL_IME_GUARD_SENTINEL)) {
      return
    }
    const start = field.selectionStart
    const end = field.selectionEnd
    setFieldValueSyncedWithReact(field, field.value.slice(0, -1))
    const max = field.value.length
    try {
      field.setSelectionRange(clampSelection(start, max), clampSelection(end, max))
    } catch {
      /* ignore */
    }
  }

  const stripSoon = (field: GuardableField): void => {
    // Why: on compositionend, xterm's CompositionHelper reads the committed
    // text from the textarea in its own 0ms timeout; stripping only the
    // trailing sentinel is safe in either order, but deferring keeps this
    // guard out of the synchronous composition event chain entirely.
    setTimeout(() => {
      if (!composing) {
        strip(field)
      }
    }, 0)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (composing) {
      return
    }
    // Why: keyCode 229 ("Process") is the IME-consumed keydown that precedes
    // compositionstart, before any text lands in the field — the last safe
    // moment to reposition the caret without disturbing an active composition.
    if (event.keyCode !== IME_PROCESS_KEY_CODE && event.key !== 'Process') {
      return
    }
    const field = resolveAutofillGuardableField(event.target)
    if (field) {
      arm(field)
    }
  }

  const onCompositionStart = (event: CompositionEvent): void => {
    if (resolveAutofillGuardableField(event.target)) {
      composing = true
    }
  }

  const onCompositionEnd = (event: CompositionEvent): void => {
    composing = false
    const field = resolveAutofillGuardableField(event.target)
    if (field) {
      stripSoon(field)
    }
  }

  const onInput = (event: Event): void => {
    if (composing) {
      return
    }
    const field = resolveAutofillGuardableField(event.target)
    // Why: IME direct commits (e.g. 、。 without a preedit) arm on keydown 229
    // but never fire compositionend; clear their leftover sentinel here.
    if (field && field.value.endsWith(AUTOFILL_IME_GUARD_SENTINEL)) {
      stripSoon(field)
    }
  }

  const onFocusOut = (event: FocusEvent): void => {
    composing = false
    const field = resolveAutofillGuardableField(event.target)
    if (field) {
      strip(field)
    }
  }

  root.addEventListener('keydown', onKeyDown as EventListener, true)
  root.addEventListener('compositionstart', onCompositionStart as EventListener, true)
  root.addEventListener('compositionend', onCompositionEnd as EventListener, true)
  root.addEventListener('input', onInput, true)
  root.addEventListener('focusout', onFocusOut as EventListener, true)

  return {
    dispose: () => {
      root.removeEventListener('keydown', onKeyDown as EventListener, true)
      root.removeEventListener('compositionstart', onCompositionStart as EventListener, true)
      root.removeEventListener('compositionend', onCompositionEnd as EventListener, true)
      root.removeEventListener('input', onInput, true)
      root.removeEventListener('focusout', onFocusOut as EventListener, true)
    }
  }
}
