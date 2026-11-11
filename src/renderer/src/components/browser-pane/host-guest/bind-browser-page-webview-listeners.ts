import { subscribeBrowserGuestMetadata } from './browser-guest-metadata-cache'
import { getBrowserDisplayTitle } from '../describe-page/browser-page-url-display'
import { publishNativeChatVisualGuestTheme } from '@/components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher'
import { normalizeBrowserGuestSrc } from '../../../../../shared/browser/extensions/browser-extension-url'
import '../../../../../shared/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
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
    viewportPresetIdRef,
    onUpdatePageStateRef,
    setGuestRecoveryGeneration,
    focusAddressBarNow,
    syncBrowserAnnotationViewportBridge,
    faviconUrlRef,
    addressBarInputRef,
    lastKnownWebviewUrlRef,
    invalidateBrowserAnnotationDocumentRef,
    onSetUrlRef,
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
      viewportPresetIdRef,
      onUpdatePageStateRef,
      setGuestRecoveryGeneration,
      focusAddressBarNow,
      syncBrowserAnnotationViewportBridge
    })

  const { handleDidStopLoading, handleFailLoad } = createBrowserPageWebviewLoadingHandlers({
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
  })

  const {
    handleDidStartNavigation,
    handleDidRedirectNavigation,
    handleFullDidNavigate,
    handleDidNavigateInPage,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleAnnotationViewportMessage
  } = createBrowserPageWebviewNavigationHandlers({
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
  })

  const unsubscribeSystemResumed = subscribeBrowserSystemResume(guestRecovery.validateAfterResume)
  validateVisibleGuestRegistrationRef.current = guestRecovery.validateAfterResume
  retryGuestRecoveryRef.current = guestRecovery.retryRecovery

  webview.addEventListener('did-attach', handleDidAttach)
  webview.addEventListener('dom-ready', handleDomReady)
  webview.addEventListener('render-process-gone', guestRecovery.recoverRenderer)
  webview.addEventListener('destroyed', handleGuestDestroyed)
  webview.addEventListener('focus', dismissAddressBarSuggestions)
  webview.addEventListener('did-start-navigation', handleDidStartNavigation)
  webview.addEventListener('did-redirect-navigation', handleDidRedirectNavigation)
  // Why: close find only on full 'did-navigate', not the shared handler, which also fires on SPA in-page hash/pushState changes.
  const handleFindCloseOnNavigate = (): void => {
    setFindOpen(false)
    const recovery = recoveryNavigationValidationRef.current
    if (recovery?.started) {
      recovery.committed = true
    }
  }

  webview.addEventListener('did-navigate', handleFindCloseOnNavigate)
  webview.addEventListener('page-favicon-updated', handleFaviconUpdate)
  webview.addEventListener('did-fail-load', handleFailLoad)
  webview.addEventListener('console-message', handleAnnotationViewportMessage)

  const unsubscribeMetadata = subscribeBrowserGuestMetadata(browserTabId, webview, (metadata) => {
    if (!metadata || metadata.kind === 'retired') {
      return
    }
    const { kind, url, title, loading, canGoBack, canGoForward } = metadata
    if (metadata.loadError) {
      activeLoadFailureRef.current = metadata.loadError
    }
    if (kind === 'navigation') {
      handleFullDidNavigate({ url })
    } else if (kind === 'in-page') {
      handleDidNavigateInPage({ url })
    }
    if (kind === 'title' && metadata.navigationRevision > 0) {
      handleTitleUpdate({ title })
    }
    const settlement =
      kind === 'stop' || (kind === 'snapshot' && !loading && metadata.navigationRevision > 0)
        ? handleDidStopLoading()
        : null
    onUpdatePageStateRef.current(browserTabId, {
      ...settlement,
      ...(metadata.navigationRevision > 0
        ? { title: getBrowserDisplayTitle(title, url || browserTabUrlRef.current) }
        : {}),
      canGoBack,
      canGoForward,
      ...(metadata.loadError
        ? { loadError: metadata.loadError }
        : kind === 'navigation'
          ? { loadError: activeLoadFailureRef.current }
          : {}),
      ...(kind === 'snapshot' && metadata.navigationRevision === 0 ? {} : { loading })
    })
  })

  if (needsInitialNavigation) {
    publishNativeChatVisualGuestTheme()
    // Why: set src only after listeners attach so a fast localhost failure isn't missed.
    const initialUrl =
      normalizeBrowserGuestSrc(initialBrowserUrlRef.current) ?? ORCA_BROWSER_BLANK_URL
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
    unsubscribeMetadata()
    webview.removeEventListener('did-attach', handleDidAttach)
    webview.removeEventListener('dom-ready', handleDomReady)
    webview.removeEventListener('render-process-gone', guestRecovery.recoverRenderer)
    webview.removeEventListener('destroyed', handleGuestDestroyed)
    webview.removeEventListener('focus', dismissAddressBarSuggestions)
    webview.removeEventListener('did-start-navigation', handleDidStartNavigation)
    webview.removeEventListener('did-redirect-navigation', handleDidRedirectNavigation)
    webview.removeEventListener('did-navigate', handleFindCloseOnNavigate)
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
