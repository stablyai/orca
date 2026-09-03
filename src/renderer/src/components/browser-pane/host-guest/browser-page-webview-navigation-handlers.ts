import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../../shared/browser-annotation-viewport-bridge'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from './browser-page-guest-recovery'
import { rememberLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import {
  getBrowserDisplayTitle,
  isChromiumErrorPage,
  toDisplayUrl
} from '../describe-page/browser-page-url-display'
import type {
  BrowserPageNavigateEvent,
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export type BrowserPageWebviewNavigationHandlersArgs = {
  webview: Electron.WebviewTag
  browserTabId: string
  browserTabUrl: string
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  addressBarInputRef: RefObject<HTMLInputElement | null>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  addBrowserHistoryEntryRef: MutableRefObject<
    (url: string, title: string, faviconUrl?: string | null) => void
  >
  faviconUrlRef: MutableRefObject<string | null>
  setAddressBarValue: Dispatch<SetStateAction<string>>
  annotationViewportBridgeTokenRef: MutableRefObject<string>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
}

export type BrowserPageWebviewNavigationHandlers = {
  handleDidStartNavigation: (event: Electron.DidStartNavigationEvent) => void
  handleFullDidNavigate: (event: BrowserPageNavigateEvent) => void
  handleDidNavigateInPage: (event: BrowserPageNavigateEvent) => void
  handleTitleUpdate: (event: { title?: string }) => void
  handleFaviconUpdate: (event: { favicons?: string[] }) => void
  handleAnnotationViewportMessage: (event: { message?: string }) => void
}

export function createBrowserPageWebviewNavigationHandlers({
  webview,
  browserTabId,
  browserTabUrl,
  recoveryNavigationValidationRef,
  activeLoadFailureRef,
  lastKnownWebviewUrlRef,
  addressBarInputRef,
  onSetUrlRef,
  onUpdatePageStateRef,
  addBrowserHistoryEntryRef,
  faviconUrlRef,
  setAddressBarValue,
  annotationViewportBridgeTokenRef,
  setBrowserOverlayViewport
}: BrowserPageWebviewNavigationHandlersArgs): BrowserPageWebviewNavigationHandlers {
  const handleDidStartNavigation = (event: Electron.DidStartNavigationEvent): void => {
    if (!event.isMainFrame || event.isInPlace || !event.url) {
      return
    }
    const pendingRecoveryNavigation = recoveryNavigationValidationRef.current
    const browserStartedUrl = redactKagiSessionToken(event.url)
    const startedUrl = normalizeBrowserNavigationUrl(browserStartedUrl) ?? browserStartedUrl
    if (pendingRecoveryNavigation?.targetUrl === startedUrl) {
      pendingRecoveryNavigation.started = true
    }
  }

  const handleDidNavigate = (
    event: { url?: string; isMainFrame?: boolean },
    persistUrl = true,
    preserveLoadError = false
  ): void => {
    if (event.isMainFrame === false) {
      return
    }
    const currentUrl = event.url ?? webview.getURL() ?? webview.src ?? 'about:blank'
    if (isChromiumErrorPage(currentUrl)) {
      return
    }
    const browserModelUrl = redactKagiSessionToken(currentUrl)
    const normalizedBrowserModelUrl =
      normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
    lastKnownWebviewUrlRef.current = normalizedBrowserModelUrl
    rememberLiveBrowserUrl(browserTabId, browserModelUrl)
    // Why: don't overwrite in-progress typing (see above).
    if (document.activeElement !== addressBarInputRef.current) {
      setAddressBarValue(toDisplayUrl(browserModelUrl))
    }
    if (persistUrl) {
      onSetUrlRef.current(browserTabId, browserModelUrl, { preserveLoadError })
    }
    onUpdatePageStateRef.current(browserTabId, {
      title: webview.getTitle() || browserModelUrl,
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward()
    })
  }

  const handleFullDidNavigate = (event: { url?: string; isMainFrame?: boolean }): void => {
    const pendingRecoveryNavigation = recoveryNavigationValidationRef.current
    if (event.isMainFrame !== false && pendingRecoveryNavigation?.started) {
      pendingRecoveryNavigation.committed = true
    }
    const preserveRecoveryError =
      activeLoadFailureRef.current?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE
    handleDidNavigate(event, true, preserveRecoveryError)
  }

  const handleDidNavigateInPage = (event: { url?: string; isMainFrame?: boolean }): void => {
    const preserveRecoveryError =
      activeLoadFailureRef.current?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE
    handleDidNavigate(event, !preserveRecoveryError)
  }

  const handleTitleUpdate = (event: { title?: string }): void => {
    try {
      const currentUrl = webview.getURL() || browserTabUrl
      const browserModelUrl = redactKagiSessionToken(currentUrl)
      const title = getBrowserDisplayTitle(event.title, browserModelUrl)
      onUpdatePageStateRef.current(browserTabId, { title })
      addBrowserHistoryEntryRef.current(browserModelUrl, title, faviconUrlRef.current)
    } catch {
      // Why: title-updated can fire before dom-ready, making getURL() throw.
    }
  }

  const handleFaviconUpdate = (event: { favicons?: string[] }): void => {
    const faviconUrl = event.favicons?.[0] ?? null
    faviconUrlRef.current =
      faviconUrl &&
      (faviconUrl.startsWith('https://') ||
        faviconUrl.startsWith('http://') ||
        faviconUrl.startsWith('data:image/'))
        ? faviconUrl
        : null
    onUpdatePageStateRef.current(browserTabId, { faviconUrl: faviconUrlRef.current })
  }

  const handleAnnotationViewportMessage = (event: { message?: string }): void => {
    const message = typeof event.message === 'string' ? event.message : ''
    const prefix = `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${annotationViewportBridgeTokenRef.current}:`
    if (!message.startsWith(prefix)) {
      return
    }
    try {
      const next = JSON.parse(message.slice(prefix.length)) as {
        scrollX?: unknown
        scrollY?: unknown
      }
      const scrollX =
        typeof next.scrollX === 'number' && Number.isFinite(next.scrollX) ? next.scrollX : 0
      const scrollY =
        typeof next.scrollY === 'number' && Number.isFinite(next.scrollY) ? next.scrollY : 0
      setBrowserOverlayViewport((current) => {
        if (current.scrollX === scrollX && current.scrollY === scrollY) {
          return current.version === 0 ? { ...current, version: 1 } : current
        }
        return { scrollX, scrollY, version: current.version + 1 }
      })
    } catch {
      // Ignore unrelated or malformed guest console output.
    }
  }

  return {
    handleDidStartNavigation,
    handleFullDidNavigate,
    handleDidNavigateInPage,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleAnnotationViewportMessage
  }
}
