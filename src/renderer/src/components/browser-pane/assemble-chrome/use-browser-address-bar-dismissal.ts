import { useEffect } from 'react'

/**
 * Why: Electron <webview> guests run in a separate process, so clicking the page never dispatches
 * pointerdown on the renderer document and Radix cannot detect an outside dismiss. Window blur and
 * focus moves into the guest (the host <webview> tag) close the dropdown the same way
 * BrowserImportHintButton does for its popover; Escape closes it at window capture.
 */
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

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      dismissSuggestions()
      event.preventDefault()
      event.stopImmediatePropagation()
    }

    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('focusin', handleFocusIn, true)
    window.addEventListener('keydown', handleEscape, true)
    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('focusin', handleFocusIn, true)
      window.removeEventListener('keydown', handleEscape, true)
    }
  }, [dismissSuggestions, open])
}
