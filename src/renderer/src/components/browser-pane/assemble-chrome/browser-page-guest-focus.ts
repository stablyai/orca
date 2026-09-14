import { useMemo, type RefObject } from 'react'

/**
 * How a browser pane hands focus to whatever renders the page. Panes differ in what that
 * is — an Electron <webview> guest, or a streamed screencast surface — so the chrome focus
 * rules stay identical across them by talking to this instead of a webview ref.
 */
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
      isAttached: () => webviewRef.current !== null,
      focus: () => {
        const webview = webviewRef.current
        if (!webview) {
          return false
        }
        try {
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

/**
 * Guest focus for panes whose page is a DOM node. `fallbackRef` covers the window where the
 * primary element does not exist yet — the streamed pane renders no screencast <img> until
 * its first frame arrives, so before then its viewport is the only thing focus can land on.
 */
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
