import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from './browser-page-guest-recovery'
import { releaseBrowserPageMount } from './browser-page-mount-admission'
import { rememberLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import { resolveBrowserWebviewLoadFailure } from '../navigate/browser-webview-load-failure'
import { resolveActiveBrowserLoadFailure } from '../navigate/browser-load-failure-for-url'
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
  keepAddressBarFocusRef: MutableRefObject<boolean>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  setAddressBarValue: Dispatch<SetStateAction<string>>
  focusAddressBarNow: () => boolean
}

export type BrowserPageWebviewLoadingHandlers = {
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
  keepAddressBarFocusRef,
  recoveryNavigationValidationRef,
  onUpdatePageStateRef,
  onSetUrlRef,
  setAddressBarValue,
  focusAddressBarNow
}: BrowserPageWebviewLoadingHandlersArgs): BrowserPageWebviewLoadingHandlers {
  const handleDidStopLoading = (): void => {
    // Admission starts background guests only; after any first load settlement, normal paint-retention rules decide layout.
    releaseBrowserPageMount(browserTabId)
    const currentUrl = webview.getURL() || webview.src || 'about:blank'
    const browserModelUrl = redactKagiSessionToken(currentUrl)
    const activeLoadFailure = activeLoadFailureRef.current
    if (isChromiumErrorPage(currentUrl)) {
      const attemptedUrl = redactKagiSessionToken(
        browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
      )
      // Retain reported failure codes and retry semantics; use a generic message only when none arrived.
      const failure =
        resolveActiveBrowserLoadFailure(activeLoadFailure, attemptedUrl) ??
        ({
          code: -1,
          description: translate(
            'auto.components.browser.pane.BrowserPane.e48569ac6d',
            'This site could not be reached.'
          ),
          validatedUrl: attemptedUrl
        } satisfies BrowserLoadError)
      activeLoadFailureRef.current = failure
      onUpdatePageStateRef.current(browserTabId, { loading: false, loadError: failure })
      return
    }
    if (activeLoadFailure?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE) {
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
    handleDidStopLoading,
    handleFailLoad
  }
}
