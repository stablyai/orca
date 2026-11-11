// Dictation inserts through editor commands, which fire no DOM input, so any trusted input or composition is the user's.
const COMPOSER_TAKEOVER_EVENTS = [
  'keydown',
  'paste',
  'drop',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'input',
  'focusout'
]
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

export function isAppActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Calls onTakeover when the user edits, presses anywhere, or leaves the composer or app. */
export function watchComposerTakeover(root: HTMLElement, onTakeover: () => void): () => void {
  const listening = new AbortController()
  const options = { capture: true, signal: listening.signal }
  const onComposerEvent = (event: Event): void => {
    const notTakeover =
      !event.isTrusted ||
      (event instanceof KeyboardEvent && MODIFIER_KEYS.has(event.key)) ||
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        root.contains(event.relatedTarget))
    if (!notTakeover) {
      onTakeover()
    }
  }
  const onAppLeave = (): void => {
    if (!isAppActive()) {
      onTakeover()
    }
  }
  for (const type of COMPOSER_TAKEOVER_EVENTS) {
    root.addEventListener(type, onComposerEvent, options)
  }
  // Caret clicks, suggestion picks and clicks elsewhere fire none of the composer's own events.
  document.addEventListener('pointerdown', onTakeover, options)
  window.addEventListener('blur', onAppLeave, options)
  document.addEventListener('visibilitychange', onAppLeave, options)
  return () => listening.abort()
}
