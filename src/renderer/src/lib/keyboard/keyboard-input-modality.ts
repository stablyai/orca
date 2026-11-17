// 'virtual' is focus moved by assistive tech (e.g. VoiceOver), which sends no DOM input first.
type FocusModality = 'keyboard' | 'pointer' | 'virtual'

let modality: FocusModality | null = null
let inputSinceLastFocus = false
let windowBlurredSinceLastFocus = false
let scriptFocusDepth = 0
let stopTracking: (() => void) | null = null

function onKeyDown(event: KeyboardEvent): void {
  inputSinceLastFocus = true
  // Shortcuts like Cmd+, are commands, not keyboard navigation.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    modality = 'keyboard'
  }
}

function onPointerDown(): void {
  inputSinceLastFocus = true
  modality = 'pointer'
}

// A press has moved focus once its release task ends (a <label> click focuses its control after
// pointerup and click listeners); later focus without new input isn't the pointer's.
function onPointerUp(): void {
  setTimeout(() => {
    inputSinceLastFocus = false
  }, 0)
}

function onFocusIn(): void {
  // Focus with no input, not moved by our own scripts, and not the window regaining focus came from assistive tech.
  if (!inputSinceLastFocus && !windowBlurredSinceLastFocus && scriptFocusDepth === 0) {
    modality = 'virtual'
  }
  inputSinceLastFocus = false
  windowBlurredSinceLastFocus = false
}

function startTracking(target: Window & typeof globalThis): () => void {
  const onWindowBlur = (event: FocusEvent): void => {
    if (event.target === target) {
      windowBlurredSinceLastFocus = true
    }
  }
  const prototype = target.HTMLElement.prototype
  const nativeFocus = prototype.focus
  // Script focus (e.g. an overlay returning focus to its trigger) keeps the modality that caused it.
  const trackedFocus = function (this: HTMLElement, options?: FocusOptions): void {
    scriptFocusDepth += 1
    try {
      nativeFocus.call(this, options)
    } finally {
      scriptFocusDepth -= 1
    }
  }
  prototype.focus = trackedFocus
  // Capture on window so handlers that stop propagation can't hide the input.
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('pointerdown', onPointerDown, true)
  target.addEventListener('mousedown', onPointerDown, true)
  target.addEventListener('pointerup', onPointerUp, true)
  // A touch that turns into a scroll ends with pointercancel instead of pointerup.
  target.addEventListener('pointercancel', onPointerUp, true)
  target.addEventListener('focusin', onFocusIn, true)
  target.addEventListener('blur', onWindowBlur, true)
  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('pointerdown', onPointerDown, true)
    target.removeEventListener('mousedown', onPointerDown, true)
    target.removeEventListener('pointerup', onPointerUp, true)
    target.removeEventListener('pointercancel', onPointerUp, true)
    target.removeEventListener('focusin', onFocusIn, true)
    target.removeEventListener('blur', onWindowBlur, true)
    if (prototype.focus === trackedFocus) {
      prototype.focus = nativeFocus
    }
  }
}

export function stopFocusModalityTracking(): void {
  stopTracking?.()
  stopTracking = null
}

if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function' &&
  typeof window.HTMLElement === 'function'
) {
  stopTracking = startTracking(window)
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopFocusModalityTracking)
}

/** Whether the latest focus came from keyboard navigation or assistive tech, not a pointer. */
export function isKeyboardOrVirtualFocus(): boolean {
  return modality === 'keyboard' || modality === 'virtual'
}
