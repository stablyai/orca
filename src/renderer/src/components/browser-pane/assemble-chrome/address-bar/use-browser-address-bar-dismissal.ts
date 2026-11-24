import { useEffect } from 'react'

/** Guest clicks bypass renderer pointerdown and Radix outside-dismiss; close on window blur or guest focus, leaving Escape to the bar. */
export function useBrowserAddressBarDismissal(open: boolean, dismissSuggestions: () => void): void {
  useEffect(() => {
    if (!open) {
      return
    }

    const handleWindowBlur = (): void => {
      dismissSuggestions()
    }

    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.tagName !== 'WEBVIEW') {
        return
      }
      dismissSuggestions()
    }

    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('focusin', handleFocusIn, true)
    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('focusin', handleFocusIn, true)
    }
  }, [dismissSuggestions, open])
}
