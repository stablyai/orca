import { useEffect } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'

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
      if (hasVisibleOverlay()) {
        return
      }

      // Esc first blurs input; leave the page only when focus is outside one.
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
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [blocked, closeTaskPage])
}
