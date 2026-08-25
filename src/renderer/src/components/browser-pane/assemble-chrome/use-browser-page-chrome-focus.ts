import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react'
import { useAppStore } from '@/store'
import {
  consumeBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from '../host-guest/browser-focus'

export function useBrowserPageChromeFocus({
  browserTabId,
  isActive,
  addressBarInputRef,
  webviewRef,
  keepAddressBarFocusRef
}: {
  browserTabId: string
  isActive: boolean
  addressBarInputRef: RefObject<HTMLInputElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  keepAddressBarFocusRef: MutableRefObject<boolean>
}): {
  focusAddressBarNow: () => boolean
  focusWebviewNow: () => boolean
} {
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)

  const focusAddressBarNow = useCallback(() => {
    const input = addressBarInputRef.current
    if (!input) {
      return false
    }
    webviewRef.current?.blur()
    input.focus()
    input.select()
    return document.activeElement === input
  }, [addressBarInputRef, webviewRef])

  const focusWebviewNow = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) {
      return false
    }
    addressBarInputRef.current?.blur()
    try {
      webview.focus()
    } catch {
      // Why: WebViewElement.focus() reads null internals once the guest is destroyed (STA-3448).
      return false
    }
    return document.activeElement === webview
  }, [addressBarInputRef, webviewRef])

  useEffect(() => {
    if (!isActive) {
      return
    }
    if (!consumeAddressBarFocusRequest(browserTabId)) {
      return
    }
    keepAddressBarFocusRef.current = true
    // Why: terminal activation re-grabs focus a frame later; retry a few frames to win the race, but stay one-shot so revisiting the tab doesn't steal focus.
    let cancelled = false
    let frameId = 0
    let attempts = 0
    const focusAddressBar = (): void => {
      if (cancelled) {
        return
      }
      focusAddressBarNow()
      attempts += 1
      if (attempts < 6) {
        frameId = window.requestAnimationFrame(focusAddressBar)
      } else {
        keepAddressBarFocusRef.current = false
      }
    }
    frameId = window.requestAnimationFrame(focusAddressBar)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
      // Why: aborting mid-retry would otherwise latch the flag on and suppress guest focus forever.
      keepAddressBarFocusRef.current = false
    }
  }, [
    browserTabId,
    consumeAddressBarFocusRequest,
    focusAddressBarNow,
    isActive,
    keepAddressBarFocusRef
  ])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(() => {
      focusAddressBarNow()
    })
  }, [focusAddressBarNow, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const focusTarget = consumeBrowserFocusRequest(browserTabId)
    if (!focusTarget) {
      return
    }
    keepAddressBarFocusRef.current = focusTarget === 'address-bar'
    let cancelled = false
    let frameId = 0
    let attempts = 0
    const runFocus = (): void => {
      if (cancelled) {
        return
      }
      const didFocus = focusTarget === 'address-bar' ? focusAddressBarNow() : focusWebviewNow()
      attempts += 1
      if (!didFocus && attempts < 6) {
        frameId = window.requestAnimationFrame(runFocus)
      }
    }
    // Why: focus can be queued before the pane mounts; persisting outside React lets it be claimed on mount instead of racing an event.
    frameId = window.requestAnimationFrame(runFocus)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [browserTabId, focusAddressBarNow, focusWebviewNow, isActive, keepAddressBarFocusRef])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleBrowserFocusRequest = (event: Event): void => {
      const detail = (event as CustomEvent<BrowserFocusRequestDetail>).detail
      if (!detail || detail.pageId !== browserTabId) {
        return
      }
      const focusTarget = consumeBrowserFocusRequest(browserTabId)
      if (!focusTarget) {
        return
      }
      if (focusTarget === 'address-bar') {
        // Why: palette-triggered address-bar focus must survive the same follow-up load events as the blank-tab path.
        keepAddressBarFocusRef.current = true
        focusAddressBarNow()
        return
      }
      keepAddressBarFocusRef.current = false
      focusWebviewNow()
    }
    // Why: an already-active page never remounts, so listen for the event to consume the durable focus request immediately.
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () =>
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
  }, [browserTabId, focusAddressBarNow, focusWebviewNow, isActive, keepAddressBarFocusRef])

  return { focusAddressBarNow, focusWebviewNow }
}
