import { useEffect, type RefObject } from 'react'

// Capture ArrowUp before Radix to return the first static item’s focus to search.
export function useTabEntryMenuReturnFocus(
  inputRef: RefObject<HTMLInputElement | null>,
  menuOpen: boolean
): void {
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const input = inputRef.current
    const menu = input?.closest<HTMLElement>('[role="menu"]')
    if (!input || !menu) {
      return
    }
    const handleMenuKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowUp') {
        return
      }
      const firstItem = menu.querySelector(
        '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])'
      )
      if (firstItem && document.activeElement === firstItem) {
        event.preventDefault()
        event.stopPropagation()
        input.focus()
      }
    }
    menu.addEventListener('keydown', handleMenuKeyDown, true)
    return () => menu.removeEventListener('keydown', handleMenuKeyDown, true)
  }, [inputRef, menuOpen])
}
