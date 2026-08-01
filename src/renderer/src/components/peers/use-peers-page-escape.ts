import { useEffect } from 'react'

function isEditableElement(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

// Why: mirrors the Mobile/Automations/Tasks pages — Esc first exits field focus, then closes the page.
export function usePeersPageEscape(onClose: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      // Why: a terminal-focused Escape (e.g. exiting vim) must reach xterm untouched
      // instead of closing the page.
      if (target.closest('.xterm')) {
        return
      }
      if (isEditableElement(target)) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      onClose()
    }
    // Why: bubble phase lets Radix popovers/selects (e.g. inside the terminal panel) consume Escape first.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
}
