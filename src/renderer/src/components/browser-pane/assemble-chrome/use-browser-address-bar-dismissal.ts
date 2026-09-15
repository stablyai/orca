import { useEffect, type RefObject } from 'react'

/**
 * Why: Electron <webview> guests run in a separate process, so clicking the page never dispatches
 * pointerdown on the renderer document and Radix cannot detect an outside dismiss. Window blur and
 * focus moves into the guest (the host <webview> tag) close the dropdown the same way
 * BrowserImportHintButton does for its popover; Escape closes it at window capture.
 */
export function useBrowserAddressBarDismissal(
  open: boolean,
  dismissSuggestions: () => void,
  inputRef?: RefObject<HTMLInputElement | null>
): void {
  useEffect(() => {
    if (!open) {
      return
    }

    const targetDoc = inputRef?.current?.ownerDocument ?? document
    const targetWindow = targetDoc.defaultView ?? window

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

    targetWindow.addEventListener('blur', handleWindowBlur)
    targetDoc.addEventListener('focusin', handleFocusIn, true)
    targetWindow.addEventListener('keydown', handleEscape, true)
    return () => {
      targetWindow.removeEventListener('blur', handleWindowBlur)
      targetDoc.removeEventListener('focusin', handleFocusIn, true)
      targetWindow.removeEventListener('keydown', handleEscape, true)
    }
  }, [dismissSuggestions, inputRef, open])
}
