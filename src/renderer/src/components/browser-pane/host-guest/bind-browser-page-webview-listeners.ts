import { normalizeBrowserNavigationUrl } from '../../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { parkBrowserPageViewport } from './browser-page-viewport'
import { subscribeBrowserSystemResume } from './browser-system-resume'
import {
  isBrowserPageRendererRecoveryPending,
  moveFocusToRendererBeforeWebviewDetach
} from './webview-registry'
import type { AttachBrowserPageWebviewArgs } from './attach-browser-page-webview'
import { createBrowserPageWebviewGuestSession } from './browser-page-webview-guest-session'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'

export function bindBrowserPageWebviewListeners({
  container,
  webview,
  needsInitialNavigation,
  onContainerDragOver,
  onContainerDrop,
  dismissAddressBarSuggestions,
  args
}: {
  container: HTMLDivElement
  webview: Electron.WebviewTag
  needsInitialNavigation: boolean
  onContainerDragOver: (event: globalThis.DragEvent) => void
  onContainerDrop: (event: globalThis.DragEvent) => void
  dismissAddressBarSuggestions: () => void
  args: AttachBrowserPageWebviewArgs
}): () => void {
  const {
    browserTabId,
    browserTabUrl,
    workspaceId,
    worktreeId,
    sessionProfileId,
    webviewRef,
    isPaintableRef,
    guestRecoveryPendingRef,
    browserTabUrlRef,
    addressBarValueRef,
    activeLoadFailureRef,
    recoveryNavigationValidationRef,
    keepAddressBarFocusRef,
    paneZoomLevelRef,
    viewportPresetIdRef,
    onUpdatePageStateRef,
    setGuestRecoveryGeneration,
    setBrowserZoomPercent,
    focusAddressBarNow,
    syncNavigationState,
    syncBrowserAnnotationViewportBridge,
    faviconUrlRef,
    addressBarInputRef,
    lastKnownWebviewUrlRef,
    trackNextLoadingEventRef,
    clearBrowserPageAnnotationsRef,
    onSetUrlRef,
    setPendingAnnotationPayload,
    setBrowserOverlayViewport,
    setAddressBarValue,
    addBrowserHistoryEntryRef,
    annotationViewportBridgeTokenRef,
    initialBrowserUrlRef,
    validateVisibleGuestRegistrationRef,
    retryGuestRecoveryRef,
    setFindOpen
  } = args

  const { guestRecovery, handleDidAttach, handleDomReady, handleGuestDestroyed } =
    createBrowserPageWebviewGuestSession({
      webview,
      browserTabId,
      workspaceId,
      worktreeId,
      sessionProfileId,
      webviewRef,
      isPaintableRef,
      guestRecoveryPendingRef,
      browserTabUrlRef,
      addressBarValueRef,
      activeLoadFailureRef,
      recoveryNavigationValidationRef,
      keepAddressBarFocusRef,
      paneZoomLevelRef,
      viewportPresetIdRef,
      onUpdatePageStateRef,
      setGuestRecoveryGeneration,
      setBrowserZoomPercent,
      focusAddressBarNow,
      syncNavigationState,
      syncBrowserAnnotationViewportBridge
    })

  const { handleDidStartLoading, handleDidStopLoading, handleFailLoad } =
    createBrowserPageWebviewLoadingHandlers({
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
    })

  const {
    handleDidStartNavigation,
    handleFullDidNavigate,
    handleDidNavigateInPage,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleAnnotationViewportMessage
  } = createBrowserPageWebviewNavigationHandlers({
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
  })

  const unsubscribeSystemResumed = subscribeBrowserSystemResume(guestRecovery.validateAfterResume)
  validateVisibleGuestRegistrationRef.current = guestRecovery.validateAfterResume
  retryGuestRecoveryRef.current = guestRecovery.retryRecovery

  webview.addEventListener('did-attach', handleDidAttach)
  webview.addEventListener('dom-ready', handleDomReady)
  webview.addEventListener('render-process-gone', guestRecovery.recoverRenderer)
  webview.addEventListener('destroyed', handleGuestDestroyed)
  webview.addEventListener('focus', dismissAddressBarSuggestions)
  webview.addEventListener('did-start-loading', handleDidStartLoading)
  webview.addEventListener('did-start-navigation', handleDidStartNavigation)
  webview.addEventListener('did-stop-loading', handleDidStopLoading)
  // Why: close find only on full 'did-navigate', not the shared handler, which also fires on SPA in-page hash/pushState changes.
  const handleFindCloseOnNavigate = (): void => {
    setFindOpen(false)
  }

  webview.addEventListener('did-navigate', handleFullDidNavigate)
  webview.addEventListener('did-navigate', handleFindCloseOnNavigate)
  webview.addEventListener('did-navigate-in-page', handleDidNavigateInPage)
  webview.addEventListener('page-title-updated', handleTitleUpdate)
  webview.addEventListener('page-favicon-updated', handleFaviconUpdate)
  webview.addEventListener('did-fail-load', handleFailLoad)
  webview.addEventListener('console-message', handleAnnotationViewportMessage)

  if (needsInitialNavigation) {
    // Why: set src only after listeners attach so a fast localhost failure isn't missed; only non-blank tabs show the loading indicator.
    const initialUrl =
      normalizeBrowserNavigationUrl(initialBrowserUrlRef.current) ?? ORCA_BROWSER_BLANK_URL
    trackNextLoadingEventRef.current = initialUrl !== ORCA_BROWSER_BLANK_URL
    lastKnownWebviewUrlRef.current = initialUrl
    webview.src = initialUrl
  } else if (isPaintableRef.current) {
    if (isBrowserPageRendererRecoveryPending(browserTabId)) {
      guestRecovery.recoverRenderer()
    } else {
      guestRecovery.validateAfterResume()
    }
  }

  return () => {
    webview.removeEventListener('did-attach', handleDidAttach)
    webview.removeEventListener('dom-ready', handleDomReady)
    webview.removeEventListener('render-process-gone', guestRecovery.recoverRenderer)
    webview.removeEventListener('destroyed', handleGuestDestroyed)
    webview.removeEventListener('focus', dismissAddressBarSuggestions)
    webview.removeEventListener('did-start-loading', handleDidStartLoading)
    webview.removeEventListener('did-start-navigation', handleDidStartNavigation)
    webview.removeEventListener('did-stop-loading', handleDidStopLoading)
    webview.removeEventListener('did-navigate', handleFullDidNavigate)
    webview.removeEventListener('did-navigate', handleFindCloseOnNavigate)
    webview.removeEventListener('did-navigate-in-page', handleDidNavigateInPage)
    webview.removeEventListener('page-title-updated', handleTitleUpdate)
    webview.removeEventListener('page-favicon-updated', handleFaviconUpdate)
    webview.removeEventListener('did-fail-load', handleFailLoad)
    webview.removeEventListener('console-message', handleAnnotationViewportMessage)
    container.removeEventListener('dragover', onContainerDragOver)
    container.removeEventListener('drop', onContainerDrop)
    unsubscribeSystemResumed()
    guestRecovery.dispose()
    if (validateVisibleGuestRegistrationRef.current === guestRecovery.validateAfterResume) {
      validateVisibleGuestRegistrationRef.current = () => {}
    }
    if (retryGuestRecoveryRef.current === guestRecovery.retryRecovery) {
      retryGuestRecoveryRef.current = () => {}
    }

    if (webviewRef.current === webview) {
      webviewRef.current = null
    }

    // Why: park the viewport on chrome unmount (worktree switch) to keep the guest alive; destroy only on explicit close.
    moveFocusToRendererBeforeWebviewDetach(webview)
    parkBrowserPageViewport(browserTabId)
  }
}
