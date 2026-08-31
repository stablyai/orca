import { useEffect, useRef, type RefObject } from 'react'
import { useWebviewDragPassthroughActive } from './use-webview-drag-passthrough-active'

/**
 * Hands focus to a client-hosted pane's guest once per activation.
 *
 * Once per activation rather than once per effect run because the drag gate makes this reactive:
 * a drag ending anywhere in the window would otherwise pull focus out of the address bar of a tab
 * that was already active, and the URL-follow guard only holds the user's draft while the bar
 * still owns focus.
 */
export function useClientHostedGuestActivationFocus({
  isActive,
  webviewRef,
  keepAddressBarFocusRef
}: {
  isActive: boolean
  webviewRef: RefObject<Electron.WebviewTag | null>
  keepAddressBarFocusRef: RefObject<boolean>
}): void {
  const dragPassthroughActive = useWebviewDragPassthroughActive()
  const focusedForActivationRef = useRef(false)

  useEffect(() => {
    if (!isActive) {
      focusedForActivationRef.current = false
      return
    }
    if (focusedForActivationRef.current) {
      return
    }
    // Why the drag gate: a tab drag preview-activates whatever it hovers, and focusing the guest
    // hands focus to another WebContents — the embedder blur that follows reads as an aborted drag.
    // Why it alone leaves the latch down: the activation it suppressed still wants its focus, and
    // this effect is reactive, so it lands as soon as the drag ends.
    if (dragPassthroughActive) {
      return
    }
    focusedForActivationRef.current = true
    // Why: a new blank tab is claiming the address bar; focusing the guest here would yank it straight back.
    if (keepAddressBarFocusRef.current) {
      return
    }
    webviewRef.current?.focus()
  }, [dragPassthroughActive, isActive, keepAddressBarFocusRef, webviewRef])
}
