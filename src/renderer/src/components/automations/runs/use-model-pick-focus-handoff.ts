// Moves focus from the model picker to the confirmation that replaces it, only while the user
// stayed with the picker.
import { useCallback, useEffect, useRef } from 'react'

const PICKER_SELECTOR = '[data-automation-model-picker]'

export function useModelPickFocusHandoff(): {
  /** Call when a pick is sent from the picker. */
  arm: () => void
  /** Ref for the confirmation; it takes focus once if still armed and focus is nowhere else. */
  takeFocus: (node: HTMLElement | null) => void
} {
  const armed = useRef(false)
  useEffect(() => {
    // Why: once the user moves focus or clicks outside the picker, where they went is theirs.
    const release = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(PICKER_SELECTOR))) {
        armed.current = false
      }
    }
    document.addEventListener('focusin', release, true)
    document.addEventListener('pointerdown', release, true)
    return () => {
      document.removeEventListener('focusin', release, true)
      document.removeEventListener('pointerdown', release, true)
    }
  }, [])
  const arm = useCallback(() => {
    armed.current = true
  }, [])
  const takeFocus = useCallback((node: HTMLElement | null) => {
    if (!node || !armed.current) {
      return
    }
    armed.current = false
    const active = node.ownerDocument.activeElement
    // The picker unmounts as the confirmation mounts, which leaves focus on the page.
    if (!active || active === node.ownerDocument.body) {
      node.focus()
    }
  }, [])
  return { arm, takeFocus }
}
