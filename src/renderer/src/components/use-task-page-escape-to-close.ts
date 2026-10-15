import { useEffect } from 'react'

/** Esc closes the Tasks page unless a modal, menu, or focused field should own it. */
export function useTaskPageEscapeToClose(blocked: boolean, closeTaskPage: () => void): void {
  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (blocked) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: open menus/popovers/selects own Esc; capture-phase leave would steal it from Radix.
      if (
        document.querySelector(
          '[data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"], [role="menu"]'
        )
      ) {
        return
      }

      // Why: Esc first blurs a focused input so it doesn't accidentally close the whole page; only closes once focus is outside an input.
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
      closeTaskPage()
    }
    window.addEventListener('keydown', onKeyDown, {
      capture: true
    })
    return () =>
      window.removeEventListener('keydown', onKeyDown, {
        capture: true
      })
  }, [blocked, closeTaskPage])
}
