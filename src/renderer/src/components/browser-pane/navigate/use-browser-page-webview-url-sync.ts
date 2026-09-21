import { useEffect, useLayoutEffect, type MutableRefObject, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import {
  applyBrowserPageViewportLayout,
  syncBrowserPageChromeInset
} from '../host-guest/browser-page-viewport'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { shouldPollChromiumErrorPage } from './chromium-error-page-polling'
import { isChromiumErrorPage } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'

export function useBrowserPageWebviewUrlSync({
  browserTabId,
  browserTabUrl,
  browserTabLoading,
  isActive,
  isPaintable,
  slotViewport,
  webviewRef,
  chromeHeaderRef,
  lastKnownWebviewUrlRef,
  trackNextLoadingEventRef,
  keepAddressBarFocusRef,
  addressBarInputRef,
  browserTabUrlRef,
  addressBarValueRef,
  onUpdatePageStateRef,
  focusWebviewNow
}: {
  browserTabId: string
  browserTabUrl: string
  browserTabLoading: boolean
  isActive: boolean
  isPaintable: boolean
  slotViewport: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  chromeHeaderRef: RefObject<HTMLDivElement | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  trackNextLoadingEventRef: MutableRefObject<boolean>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  addressBarInputRef: RefObject<HTMLInputElement | null>
  browserTabUrlRef: MutableRefObject<string>
  addressBarValueRef: MutableRefObject<string>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
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
    const normalizedUrl = normalizeBrowserNavigationUrl(browserTabUrl)
    if (!normalizedUrl) {
      return
    }
    // Why: navigation events set both the store URL and this ref; a match means the change came from navigation, so skip to avoid a redirect infinite loop.
    if (lastKnownWebviewUrlRef.current === normalizedUrl) {
      return
    }
    let liveUrl: string | null = null
    try {
      liveUrl = webview.getURL() || null
    } catch {
      // Why: a newly attached guest can reject getURL(); skip so a transient error isn't misread as a mismatch and force-navigated.
      return
    }
    const normalizedLiveUrl = liveUrl ? (normalizeBrowserNavigationUrl(liveUrl) ?? liveUrl) : null
    const declaredSrc = webview.getAttribute('src')
    if (
      normalizedLiveUrl !== normalizedUrl &&
      webview.src !== normalizedUrl &&
      declaredSrc !== normalizedUrl
    ) {
      // Why: browserTab.url changes are Orca-driven navigations; gate did-start-loading so only real navigations show loading UI.
      trackNextLoadingEventRef.current = normalizedUrl !== ORCA_BROWSER_BLANK_URL
      lastKnownWebviewUrlRef.current = normalizedUrl
      webview.src = normalizedUrl
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
    trackNextLoadingEventRef,
    webviewRef
  ])

  useEffect(() => {
    if (!shouldPollChromiumErrorPage({ isActive, loading: browserTabLoading })) {
      return
    }

    const detectChromiumErrorPage = (): void => {
      const webview = webviewRef.current
      if (!webview) {
        return
      }
      try {
        const currentUrl = webview.getURL() || webview.src || ''
        if (!isChromiumErrorPage(currentUrl)) {
          return
        }

        const attemptedUrl = browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
        onUpdatePageStateRef.current(browserTabId, {
          loading: false,
          loadError: {
            code: -1,
            description: translate(
              'auto.components.browser.pane.BrowserPane.e48569ac6d',
              'This site could not be reached.'
            ),
            validatedUrl: redactKagiSessionToken(attemptedUrl)
          }
        })
      } catch {
        // Why: ignore transient getURL() errors from a mid-attach guest; this poll is only a fallback.
      }
    }

    // Why: some Electron builds paint chrome-error pages without a did-fail-load event; poll only while the active tab loads as a fallback.
    // Why gated: a page stuck loading would otherwise poll 4x/sec forever behind a hidden window. The guest URL is durable state, so the becoming-visible run re-derives anything a hidden window skipped.
    return installWindowVisibilityInterval({
      run: detectChromiumErrorPage,
      intervalMs: 250
    })
  }, [
    addressBarValueRef,
    browserTabId,
    browserTabLoading,
    browserTabUrlRef,
    isActive,
    onUpdatePageStateRef,
    webviewRef
  ])
}
