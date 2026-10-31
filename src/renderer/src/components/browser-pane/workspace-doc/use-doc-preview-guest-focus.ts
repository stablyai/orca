import { useEffect, type MutableRefObject } from 'react'

const GUEST_FOCUS_FRAMES = 10

/** Hand off to attached preview guests, including replacements after re-mint; window re-entry must yield to user-claimed focus. */
export function useDocPreviewGuestFocus({
  webviewRef,
  holdsGuestFocus,
  ready,
  previewId,
  remintCount
}: {
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  holdsGuestFocus: boolean
  ready: boolean
  previewId: string
  remintCount: number
}): void {
  useEffect(() => {
    if (!holdsGuestFocus || !ready) {
      return
    }
    let frameId = 0
    let attempts = 0
    let claimedOnly = false
    const focusGuest = (): void => {
      const webview = webviewRef.current
      attempts += 1
      // Window re-entry can follow a tab click; never reclaim focus from the reader’s chosen target.
      if (
        claimedOnly &&
        document.activeElement !== document.body &&
        document.activeElement !== webview
      ) {
        return
      }
      try {
        webview?.focus()
      } catch {
        // Why swallowed: WebViewElement.focus() reads null internals once the guest is destroyed.
        return
      }
      // Ready can precede layout/attachment; retry briefly until the guest accepts focus.
      if (document.activeElement !== webview && attempts < GUEST_FOCUS_FRAMES) {
        frameId = window.requestAnimationFrame(focusGuest)
      }
    }
    const offerFocus = (yieldToOtherClaims: boolean): void => {
      window.cancelAnimationFrame(frameId)
      attempts = 0
      claimedOnly = yieldToOtherClaims
      frameId = window.requestAnimationFrame(focusGuest)
    }
    // Why assertive: the reader just made this preview their surface, so the handoff is the point.
    offerFocus(false)
    // Window focus returns to the embedder after app switching; offer unclaimed focus back to the guest.
    const reofferFocus = (): void => offerFocus(true)
    window.addEventListener('focus', reofferFocus)
    return () => {
      window.removeEventListener('focus', reofferFocus)
      window.cancelAnimationFrame(frameId)
    }
  }, [holdsGuestFocus, previewId, ready, remintCount, webviewRef])
}
