import { useEffect, useRef, type RefObject } from 'react'
import type { BrowserPageGuestFocus } from '../assemble-chrome/browser-page-guest-focus'
import { useWebviewDragPassthroughActive } from './use-webview-drag-passthrough-active'

/** Focus once per activation; rerunning after every drag would steal an active address-bar draft and release its URL-follow guard. */
export function useClientHostedGuestActivationFocus({
  isActive,
  guestFocus,
  keepAddressBarFocusRef
}: {
  isActive: boolean
  /** Not the raw tag: a retired page's <webview> is out of the DOM, where focus() throws (STA-3448). */
  guestFocus: BrowserPageGuestFocus
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
    // Guest focus blurs the embedder and aborts drags; defer without latching so this activation receives focus when the drag ends.
    if (dragPassthroughActive) {
      return
    }
    focusedForActivationRef.current = true
    // Why: a new blank tab is claiming the address bar; focusing the guest here would yank it straight back.
    if (keepAddressBarFocusRef.current) {
      return
    }
    guestFocus.focus()
  }, [dragPassthroughActive, guestFocus, isActive, keepAddressBarFocusRef])
}
