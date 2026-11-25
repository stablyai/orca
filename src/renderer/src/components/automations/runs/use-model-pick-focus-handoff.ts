// Moves focus from the model picker to the confirmation that replaces it, only while the user
// was with the picker when the pick finished.
import { useCallback, useEffect, useRef } from 'react'

const PICKER_SELECTOR = '[data-automation-model-picker]'

function insidePicker(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PICKER_SELECTOR) !== null
}

export function useModelPickFocusHandoff(): {
  /** Call when a pick is sent from the picker. */
  arm: () => void
  /** Ref for the confirmation; it takes focus once if the user was last with the picker. */
  takeFocus: (node: HTMLElement | null) => void
} {
  const pending = useRef(false)
  // Why: decided by where the user last moved, before the picker unmounts and drops focus to the
  // page; a click on other content also leaves focus on the page, and that must not be stolen.
  const withPicker = useRef(false)
  useEffect(() => {
    const track = (event: Event): void => {
      withPicker.current = insidePicker(event.target)
    }
    document.addEventListener('focusin', track, true)
    document.addEventListener('pointerdown', track, true)
    return () => {
      document.removeEventListener('focusin', track, true)
      document.removeEventListener('pointerdown', track, true)
    }
  }, [])
  const arm = useCallback(() => {
    pending.current = true
    withPicker.current = true
  }, [])
  const takeFocus = useCallback((node: HTMLElement | null) => {
    if (!node || !pending.current) {
      return
    }
    pending.current = false
    if (withPicker.current) {
      node.focus()
    }
  }, [])
  return { arm, takeFocus }
}
