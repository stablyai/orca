import { useEffect, type MutableRefObject } from 'react'

/** Frames a preview keeps offering focus to a guest that is still attaching. */
const GUEST_FOCUS_FRAMES = 10

/**
 * Hands a ready preview's guest the keyboard. A preview has no address bar to make the usual
 * handoff, so a surfaced document would otherwise look active while its keyboard and link input
 * land elsewhere. `remintCount` re-runs the handoff when a re-mint replaces the guest.
 */
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
      // Why a re-offer yields: it is a handoff for focus nothing else wanted, and the reader
      // pressing a tab lands here first. Taking it back would fight them for the keyboard, which
      // is what shut the tab strip while a preview was open.
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
      // Why retried: the guest takes focus only once it is attached and laid out, a frame or two
      // after it reports ready.
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
    // Why re-offered on the window's own focus: another app taking the front takes focus out of the
    // guest, and coming back puts it on the embedder. Nothing hands it on, so the route out of the
    // preview would stay shut until something remounted it.
    const reofferFocus = (): void => offerFocus(true)
    window.addEventListener('focus', reofferFocus)
    return () => {
      window.removeEventListener('focus', reofferFocus)
      window.cancelAnimationFrame(frameId)
    }
  }, [holdsGuestFocus, previewId, ready, remintCount, webviewRef])
}
