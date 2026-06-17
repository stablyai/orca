import { useEffect } from 'react'

export function useMobilePageEscapeKey(closeMobilePage: () => void): void {
  // Why: mirror Automations/Tasks — Esc first exits field focus, then closes the page.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      closeMobilePage()
    }
    // Why: bubble phase (no capture) so Radix popovers/selects get a chance
    // to consume Escape first; the defaultPrevented check below then skips.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeMobilePage])
}
