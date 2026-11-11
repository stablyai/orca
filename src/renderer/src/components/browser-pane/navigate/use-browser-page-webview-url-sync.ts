import {
  issueBrowserGuestNavigation,
  cachedBrowserGuestMetadata
} from '../host-guest/browser-guest-metadata-cache'
import { useEffect, useLayoutEffect, type MutableRefObject, type RefObject } from 'react'
import { normalizeBrowserNavigationUrl } from '../../../../../shared/browser-url'
import '../../../../../shared/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
import { normalizeBrowserGuestSrc } from '../../../../../shared/browser/extensions/browser-extension-url'
import {
  applyBrowserPageViewportLayout,
  syncBrowserPageChromeInset
} from '../host-guest/browser-page-viewport'

export function useBrowserPageWebviewUrlSync({
  browserTabId,
  browserTabUrl,
  isActive,
  isPaintable,
  slotViewport,
  webviewRef,
  chromeHeaderRef,
  lastKnownWebviewUrlRef,
  keepAddressBarFocusRef,
  addressBarInputRef,
  focusWebviewNow
}: {
  browserTabId: string
  browserTabUrl: string
  isActive: boolean
  isPaintable: boolean
  slotViewport: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  chromeHeaderRef: RefObject<HTMLDivElement | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  addressBarInputRef: RefObject<HTMLInputElement | null>
  focusWebviewNow: () => boolean
}): void {
  useLayoutEffect(() => {
    applyBrowserPageViewportLayout(browserTabId, { paintable: isPaintable, active: isActive })
    const syncChromeInset = (): void => {
      const header = chromeHeaderRef.current
      if (!header) {
        return
      }
      syncBrowserPageChromeInset(browserTabId, header.offsetHeight)
    }
    syncChromeInset()
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncChromeInset)
    const header = chromeHeaderRef.current
    if (header) {
      resizeObserver?.observe(header)
    }
    return () => {
      resizeObserver?.disconnect()
    }
    // Why: a replacement slot root needs visibility and chrome inset re-applied.
  }, [browserTabId, chromeHeaderRef, isActive, isPaintable, slotViewport])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    const normalizedUrl = normalizeBrowserGuestSrc(browserTabUrl)
    if (!normalizedUrl) {
      return
    }
    // Why: navigation events set both the store URL and this ref; a match means the change came from navigation, so skip to avoid a redirect infinite loop.
    if (lastKnownWebviewUrlRef.current === normalizedUrl) {
      return
    }
    const liveUrl = cachedBrowserGuestMetadata(webview)?.url ?? null
    const normalizedLiveUrl = liveUrl ? (normalizeBrowserNavigationUrl(liveUrl) ?? liveUrl) : null
    const declaredSrc = webview.getAttribute('src')
    if (
      normalizedLiveUrl !== normalizedUrl &&
      webview.src !== normalizedUrl &&
      declaredSrc !== normalizedUrl
    ) {
      lastKnownWebviewUrlRef.current = normalizedUrl
      issueBrowserGuestNavigation(webview, () => {
        webview.src = normalizedUrl
      })
      if (normalizedUrl !== ORCA_BROWSER_BLANK_URL) {
        keepAddressBarFocusRef.current = false
        if (document.activeElement === addressBarInputRef.current) {
          focusWebviewNow()
        }
      }
    }
  }, [
    addressBarInputRef,
    browserTabUrl,
    focusWebviewNow,
    keepAddressBarFocusRef,
    lastKnownWebviewUrlRef,
    webviewRef
  ])
}
