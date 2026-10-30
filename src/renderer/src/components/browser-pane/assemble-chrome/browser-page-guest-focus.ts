import { useMemo, type RefObject } from 'react'
import { hasBrowserClientPageAttachedGuest } from '../browser-client-page-retained-elements'

/** Abstract webview and streamed-surface focus so chrome rules stay consistent across backends. */
export type BrowserPageGuestFocus = {
  blur: () => void
  /** Whether the guest actually took focus. */
  focus: () => boolean
  /** Whether there is a guest to focus at all; callers must not give up chrome focus without one. */
  isAttached: () => boolean
}

/** Guest focus for the panes whose page is a real <webview>: local and client-hosted. */
export function useWebviewGuestFocus(
  webviewRef: RefObject<Electron.WebviewTag | null>
): BrowserPageGuestFocus {
  return useMemo(
    () => ({
      blur: () => webviewRef.current?.blur(),
      // Why the live guest: focusing a webview before its guest attaches is lost once it does.
      isAttached: () =>
        webviewRef.current !== null && hasBrowserClientPageAttachedGuest(webviewRef.current),
      focus: () => {
        const webview = webviewRef.current
        if (!webview) {
          return false
        }
        try {
          // Why: focus the window first so the close shortcut closes the new tab, not the original tab.
          window.focus()
          webview.focus()
        } catch {
          // Why: WebViewElement.focus() reads null internals once the guest is destroyed (STA-3448).
          return false
        }
        return document.activeElement === webview
      }
    }),
    [webviewRef]
  )
}

/** Before the first streamed image arrives, focus its viewport fallback. */
export function useElementGuestFocus(
  primaryRef: RefObject<HTMLElement | null>,
  fallbackRef?: RefObject<HTMLElement | null>
): BrowserPageGuestFocus {
  return useMemo(
    () => ({
      blur: () => (primaryRef.current ?? fallbackRef?.current)?.blur(),
      isAttached: () => (primaryRef.current ?? fallbackRef?.current ?? null) !== null,
      focus: () => {
        const element = primaryRef.current ?? fallbackRef?.current ?? null
        if (!element) {
          return false
        }
        element.focus()
        return document.activeElement === element
      }
    }),
    [fallbackRef, primaryRef]
  )
}
