import { cachedBrowserGuestMetadata } from './browser-guest-metadata-cache'
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import '../../../../../shared/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
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
  handleDidStopLoading: () => BrowserTabPageState | null
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
  onSetUrlRef,
  setAddressBarValue,
  focusAddressBarNow
}: BrowserPageWebviewLoadingHandlersArgs): BrowserPageWebviewLoadingHandlers {
  const handleDidStopLoading = (): BrowserTabPageState | null => {
    // Admission starts background guests only; after any first load settlement, normal paint-retention rules decide layout.
    releaseBrowserPageMount(browserTabId)
    const metadata = cachedBrowserGuestMetadata(webview)
    if (!metadata) {
      return null
    }
    const currentUrl = metadata.url
    const browserModelUrl = redactKagiSessionToken(currentUrl)
    const activeLoadFailure = metadata.loadError ?? activeLoadFailureRef.current
    if (metadata.loadError) {
      activeLoadFailureRef.current = metadata.loadError
      return { loading: false, loadError: metadata.loadError }
    }
    if (metadata.hasCertificateFailure) {
      return { loading: false }
    }
    if (metadata.errorPage || isChromiumErrorPage(currentUrl)) {
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
      return { loading: false, loadError: failure }
    }
    if (!metadata.url) {
      return { loading: false }
    }
    if (activeLoadFailure?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE) {
      return {
        loading: false,
        title: getBrowserDisplayTitle(metadata.title, browserModelUrl),
        faviconUrl: faviconUrlRef.current,
        loadError: activeLoadFailure
      }
    }
    activeLoadFailureRef.current = null
    const normalizedUrl = normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
    const urlChanged = lastKnownWebviewUrlRef.current !== normalizedUrl
    lastKnownWebviewUrlRef.current = normalizedUrl
    rememberLiveBrowserUrl(browserTabId, browserModelUrl)
    // Why: don't overwrite in-progress typing (see the browserTab.url sync effect above).
    if (document.activeElement !== addressBarInputRef.current) {
      setAddressBarValue(toDisplayUrl(browserModelUrl))
    }
    if (urlChanged) {
      onSetUrlRef.current(browserTabId, browserModelUrl)
    }
    if (keepAddressBarFocusRef.current && currentUrl === ORCA_BROWSER_BLANK_URL) {
      focusAddressBarNow()
    } else {
      keepAddressBarFocusRef.current = false
    }
    return {
      loading: false,
      title: getBrowserDisplayTitle(metadata.title, browserModelUrl),
      faviconUrl: faviconUrlRef.current,
      loadError: null
    }
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
  }

  return {
    handleDidStopLoading,
    handleFailLoad
  }
}
