import { useEffect } from 'react'

/** Something on top of the page owns Escape (a menu, popover or dialog): leave it to that. */
function escapeBelongsToOverlay(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
    ) !== null
  )
}

/**
 * RR-b / JA-01: Escape on the visible setup page leaves setup exactly like its ×, so the pending
 * start is cancelled. Without it the page stayed (hidden or not) and a sign-in finishing later
 * auto-started the saved create.
 */
export function useEscapeExitsSetup(visible: boolean, onExit: () => void): void {
  useEffect(() => {
    if (!visible) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return
      }
      if (escapeBelongsToOverlay()) {
        return
      }
      event.preventDefault()
      onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit, visible])
}
