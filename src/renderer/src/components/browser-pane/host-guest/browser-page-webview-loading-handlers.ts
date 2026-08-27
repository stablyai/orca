import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from './browser-page-guest-recovery'
import { rememberLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { resolveBrowserWebviewLoadFailure } from '../navigate/browser-webview-load-failure'
import {
  getBrowserDisplayTitle,
  isChromiumErrorPage,
  toDisplayUrl
} from '../describe-page/browser-page-url-display'
import type {
  BrowserPageFailLoadEvent,
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export type BrowserPageWebviewLoadingHandlersArgs = {
  webview: Electron.WebviewTag
  browserTabId: string
  faviconUrlRef: MutableRefObject<string | null>
  browserTabUrlRef: MutableRefObject<string>
  addressBarValueRef: MutableRefObject<string>
  addressBarInputRef: RefObject<HTMLInputElement | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  trackNextLoadingEventRef: MutableRefObject<boolean>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  clearBrowserPageAnnotationsRef: MutableRefObject<(pageId: string) => void>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  setAddressBarValue: Dispatch<SetStateAction<string>>
  focusAddressBarNow: () => boolean
}

export type BrowserPageWebviewLoadingHandlers = {
  handleDidStartLoading: () => void
  handleDidStopLoading: () => void
  handleFailLoad: (event: BrowserPageFailLoadEvent) => void
}

export function createBrowserPageWebviewLoadingHandlers({
  webview,
  browserTabId,
  faviconUrlRef,
  browserTabUrlRef,
  addressBarValueRef,
  addressBarInputRef,
  activeLoadFailureRef,
  lastKnownWebviewUrlRef,
  trackNextLoadingEventRef,
  keepAddressBarFocusRef,
  recoveryNavigationValidationRef,
  clearBrowserPageAnnotationsRef,
  onUpdatePageStateRef,
  onSetUrlRef,
  setPendingAnnotationPayload,
  setBrowserOverlayViewport,
  setAddressBarValue,
  focusAddressBarNow
}: BrowserPageWebviewLoadingHandlersArgs): BrowserPageWebviewLoadingHandlers {
  const handleDidStartLoading = (): void => {
    // Why: a reload replaces the document without changing the URL, invalidating captured element rects like a navigation does.
    clearBrowserPageAnnotationsRef.current(browserTabId)
    setPendingAnnotationPayload(null)
    setBrowserOverlayViewport({ scrollX: 0, scrollY: 0, version: 0 })
    if (!trackNextLoadingEventRef.current) {
      return
    }
    faviconUrlRef.current = null
    onUpdatePageStateRef.current(browserTabId, {
      loading: true,
      faviconUrl: null
    })
  }

  const handleDidStopLoading = (): void => {
    const currentUrl = webview.getURL() || webview.src || 'about:blank'
    const browserModelUrl = redactKagiSessionToken(currentUrl)
    const activeLoadFailure = activeLoadFailureRef.current
    if (isChromiumErrorPage(currentUrl)) {
      trackNextLoadingEventRef.current = false
      const synthesizedFailure = {
        code: -1,
        description: translate(
          'auto.components.browser.pane.BrowserPane.e48569ac6d',
          'This site could not be reached.'
        ),
        validatedUrl: redactKagiSessionToken(
          browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
        )
      }
      activeLoadFailureRef.current = synthesizedFailure
      onUpdatePageStateRef.current(browserTabId, {
        loading: false,
        loadError: synthesizedFailure
      })
      return
    }
    if (activeLoadFailure?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE) {
      trackNextLoadingEventRef.current = false
      onUpdatePageStateRef.current(browserTabId, {
        loading: false,
        title: getBrowserDisplayTitle(webview.getTitle(), browserModelUrl),
        faviconUrl: faviconUrlRef.current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        loadError: activeLoadFailure
      })
      return
    } else if (activeLoadFailure) {
      const normalizedAttemptedUrl =
        normalizeBrowserNavigationUrl(activeLoadFailure.validatedUrl) ??
        activeLoadFailure.validatedUrl
      const normalizedCurrentUrl = normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
      if (normalizedAttemptedUrl === normalizedCurrentUrl) {
        trackNextLoadingEventRef.current = false
        // Why: some failures still emit did-stop-loading on the original URL; keep loadError so the known-failed load isn't cleared to a blank surface.
        onUpdatePageStateRef.current(browserTabId, {
          loading: false,
          title: getBrowserDisplayTitle(webview.getTitle(), browserModelUrl),
          faviconUrl: faviconUrlRef.current,
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward(),
          loadError: activeLoadFailure
        })
        return
      }
    }
    trackNextLoadingEventRef.current = false
    activeLoadFailureRef.current = null
    lastKnownWebviewUrlRef.current =
      normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
    rememberLiveBrowserUrl(browserTabId, browserModelUrl)
    // Why: don't overwrite in-progress typing (see the browserTab.url sync effect above).
    if (document.activeElement !== addressBarInputRef.current) {
      setAddressBarValue(toDisplayUrl(browserModelUrl))
    }
    onSetUrlRef.current(browserTabId, browserModelUrl)
    if (keepAddressBarFocusRef.current && currentUrl === ORCA_BROWSER_BLANK_URL) {
      focusAddressBarNow()
    } else {
      keepAddressBarFocusRef.current = false
    }
    onUpdatePageStateRef.current(browserTabId, {
      loading: false,
      title: getBrowserDisplayTitle(webview.getTitle(), browserModelUrl),
      faviconUrl: faviconUrlRef.current,
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      loadError: null
    })
  }

  const handleFailLoad = (event: BrowserPageFailLoadEvent): void => {
    const loadError = resolveBrowserWebviewLoadFailure(event)
    if (!loadError) {
      return
    }
    trackNextLoadingEventRef.current = false
    const pendingRecoveryNavigation = recoveryNavigationValidationRef.current
    if (pendingRecoveryNavigation?.started) {
      recoveryNavigationValidationRef.current = null
    }
    activeLoadFailureRef.current = loadError
    onUpdatePageStateRef.current(browserTabId, {
      loading: false,
      loadError
    })
  }

  return {
    handleDidStartLoading,
    handleDidStopLoading,
    handleFailLoad
  }
}
