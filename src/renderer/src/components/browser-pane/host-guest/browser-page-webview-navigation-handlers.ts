import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from './browser-page-guest-recovery'
import { rememberLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { consumeBrowserAnnotationViewportMessage } from '../annotate/browser-annotation-viewport-message'
import {
  getBrowserDisplayTitle,
  isChromiumErrorPage,
  toDisplayUrl
} from '../describe-page/browser-page-url-display'
import {
  browserNavigationLeavesFaviconOrigin,
  pickDisplayableFaviconUrl
} from '../describe-page/browser-favicon-url'
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
  invalidateBrowserAnnotationDocumentRef: MutableRefObject<() => void>
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
  handleDidRedirectNavigation: (event: Electron.DidRedirectNavigationEvent) => void
  handleFullDidNavigate: (event: BrowserPageNavigateEvent) => void
  handleDidNavigateInPage: (event: BrowserPageNavigateEvent) => void
  handleTitleUpdate: (event: { title?: string }) => void
  handleFaviconUpdate: (event: { favicons?: string[] }) => void
  handleAnnotationViewportMessage: (event: { message?: string }) => void
}

/** Observe main-document starts, including page-initiated navigation; did-start-loading also includes iframe loads. */
export function isPageDocumentNavigationStart(event: {
  isMainFrame: boolean
  isInPlace: boolean
}): boolean {
  return event.isMainFrame && !event.isInPlace
}

export function createBrowserPageWebviewNavigationHandlers({
  webview,
  browserTabId,
  browserTabUrl,
  invalidateBrowserAnnotationDocumentRef,
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
  const clearFaviconIfOriginChanges = (
    event: Electron.DidStartNavigationEvent | Electron.DidRedirectNavigationEvent
  ): void => {
    if (!event.isMainFrame || event.isInPlace || !event.url) {
      return
    }
    const browserStartedUrl = redactKagiSessionToken(event.url)
    const startedUrl = normalizeBrowserNavigationUrl(browserStartedUrl) ?? browserStartedUrl
    // Read the departing URL from the guest; Orca sets lastKnownWebviewUrlRef to the destination before assigning src.
    let committedUrl: string | null = null
    try {
      committedUrl = webview.getURL() || null
    } catch {
      // Why: a guest that hasn't attached yet rejects getURL(); an unknown origin keeps the icon.
    }
    if (browserNavigationLeavesFaviconOrigin(committedUrl, startedUrl)) {
      faviconUrlRef.current = null
      onUpdatePageStateRef.current(browserTabId, { faviconUrl: null })
    }
  }

  const handleDidStartNavigation = (event: Electron.DidStartNavigationEvent): void => {
    if (!isPageDocumentNavigationStart(event) || !event.url) {
      return
    }
    // Same-URL reloads replace the document too; in-place updates are judged once they commit.
    invalidateBrowserAnnotationDocumentRef.current()
    setBrowserOverlayViewport({ scrollX: 0, scrollY: 0, version: 0 })
    onUpdatePageStateRef.current(browserTabId, { loading: true })
    const pendingRecoveryNavigation = recoveryNavigationValidationRef.current
    const browserStartedUrl = redactKagiSessionToken(event.url)
    const startedUrl = normalizeBrowserNavigationUrl(browserStartedUrl) ?? browserStartedUrl
    if (pendingRecoveryNavigation?.targetUrl === startedUrl) {
      pendingRecoveryNavigation.started = true
    }
    // Clear only across origins; same-site loads may never reannounce an unchanged favicon list.
    clearFaviconIfOriginChanges(event)
  }

  const handleDidRedirectNavigation = (event: Electron.DidRedirectNavigationEvent): void => {
    clearFaviconIfOriginChanges(event)
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
    // In-place route changes swap content, but fragment-only updates (scroll spies, anchors) keep the layout.
    if (lastKnownWebviewUrlRef.current?.split('#')[0] !== normalizedBrowserModelUrl.split('#')[0]) {
      invalidateBrowserAnnotationDocumentRef.current()
    }
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
    faviconUrlRef.current = pickDisplayableFaviconUrl(event.favicons)
    onUpdatePageStateRef.current(browserTabId, { faviconUrl: faviconUrlRef.current })
  }

  const handleAnnotationViewportMessage = (event: { message?: string }): void => {
    consumeBrowserAnnotationViewportMessage(
      event,
      annotationViewportBridgeTokenRef.current,
      setBrowserOverlayViewport
    )
  }

  return {
    handleDidStartNavigation,
    handleDidRedirectNavigation,
    handleFullDidNavigate,
    handleDidNavigateInPage,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleAnnotationViewportMessage
  }
}
