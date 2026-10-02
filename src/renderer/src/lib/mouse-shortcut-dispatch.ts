import type { KeybindingInput } from '../../../shared/keybindings'

/** Routes side buttons through the same focused-surface handlers as keyboard shortcuts. */
export function registerMouseShortcutDispatch(
  isBound: (input: KeybindingInput) => boolean,
  dispatchNative: (input: KeyboardEvent) => boolean = () => false
): () => void {
  const consumedButtons = new Set<number>()
  const pressedInputs = new Map<number, { target: Element; key: string }>()
  const onMouseDown = (event: MouseEvent): void => {
    const key = event.button === 3 ? 'MouseBack' : event.button === 4 ? 'MouseForward' : null
    if (!key || event.defaultPrevented) {
      return
    }
    if (pressedInputs.has(event.button)) {
      if (consumedButtons.has(event.button)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    consumedButtons.delete(event.button)
    const target = document.activeElement ?? document.body
    const input = new KeyboardEvent('keydown', {
      key,
      code: key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true
    })
    const recording = target.closest('[data-shortcut-recorder-active]') !== null
    if (!recording && !isBound(input)) {
      return
    }
    pressedInputs.set(event.button, { target, key })
    target.dispatchEvent(input)
    if (input.defaultPrevented || (!recording && dispatchNative(input))) {
      consumedButtons.add(event.button)
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  // Chromium can navigate on release; consume the rest of a handled gesture without rerunning it.
  const onMouseRelease = (event: MouseEvent): void => {
    const pressed = pressedInputs.get(event.button)
    if (event.type === 'mouseup' && pressed) {
      pressedInputs.delete(event.button)
      const target = pressed.target.isConnected ? pressed.target : window
      target.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: pressed.key,
          code: pressed.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true
        })
      )
    }
    if (!consumedButtons.has(event.button)) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type === 'auxclick') {
      consumedButtons.delete(event.button)
    }
  }
  const onBlur = (): void => {
    consumedButtons.clear()
    pressedInputs.clear()
  }
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseRelease, true)
  window.addEventListener('auxclick', onMouseRelease, true)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseRelease, true)
    window.removeEventListener('auxclick', onMouseRelease, true)
    window.removeEventListener('blur', onBlur)
  }
}
