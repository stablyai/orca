import { useEffect, type MutableRefObject } from 'react'

/**
 * Why: Electron <webview> guests run in a separate process, so clicking the page never dispatches
 * pointerdown on the renderer document and Radix cannot detect an outside dismiss. Window blur and
 * focus moves into the guest (the host <webview> tag) close the dropdown the same way
 * BrowserImportHintButton does for its popover.
 */
export function useBrowserAddressBarDismissal(
  open: boolean,
  dismissSuggestions: () => void,
  dismissSuggestionsRef: MutableRefObject<(() => void) | null> | undefined
): void {
  useEffect(() => {
    if (!dismissSuggestionsRef) {
      return
    }
    dismissSuggestionsRef.current = dismissSuggestions
    return () => {
      dismissSuggestionsRef.current = null
    }
  }, [dismissSuggestions, dismissSuggestionsRef])

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
