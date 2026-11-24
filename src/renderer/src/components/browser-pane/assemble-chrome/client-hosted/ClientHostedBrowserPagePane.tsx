import { useClientHostedPageInitialization } from '../../navigate/use-client-hosted-page-initialization'
import type { BrowserGuestMetadata } from '../../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { useBrowserAgentCursor } from '../../agent-cursor/use-browser-agent-cursor'
import { useAppStore } from '@/store/index'
import { createBrowserClientPageLoadFailureHandler } from '../../navigate/browser-client-page-guest-metadata'
import {
  browserGuestPreservesRequestedDocument,
  subscribeBrowserGuestMetadata
} from '../../host-guest/metadata/browser-guest-metadata-cache'
import { redactKagiSessionToken } from '../../../../../../shared/browser/navigation/browser-url'
import {
  forgetBrowserClientPageMetadataReports,
  startBrowserClientPageMetadataPublisher
} from '../../host-guest/metadata/browser-client-page-metadata-reporting'
import { attachBrowserClientPageToViewport } from '../../host-guest/client-pages/browser-client-page-renderer-installation'
import { useBrowserClientHostedPopupNotices } from '../../navigate/browser-client-hosted-popup-notices'
import { useBrowserClientHostedPermissionNotices } from '../../navigate/browser-client-hosted-permission-notices'
import { useClientHostedBrowserIntroTour } from './use-client-hosted-browser-intro-tour'
import { ClientHostedBrowserPageStandIn } from './client-hosted-browser-page-stand-in'
import { useClientHostedPageAttachment } from './use-client-hosted-page-attachment'
import { watchBrowserClientPageGuestLoss } from '../../host-guest/recovery/browser-client-page-guest-loss'
import { useClientHostedBrowserAnnotate } from '../../annotate/use-client-hosted-browser-annotate'
import { ClientHostedBrowserPageOverlays } from './client-hosted-browser-page-overlays'
import { ClientHostedBrowserPageToolbar } from './client-hosted-browser-page-toolbar'
import { bindBrowserClientPageChromeListeners } from './browser-client-page-chrome-listeners'
import {
  ClientHostedBrowserPageBox,
  useClientHostedBrowserPageViewport
} from './client-hosted-browser-page-box'
import { BrowserPageContextMenu } from '../context-menu/browser-page-context-menu'
import { useBrowserPageChromeFocus } from '../focus/use-browser-page-chrome-focus'
import { useBrowserAddressBarEditSession } from '../address-bar/use-browser-address-bar-edit-session'
import { useBrowserPageFindShortcuts } from '../find/use-browser-page-find-shortcuts'
import { useWebviewGuestFocus } from '../focus/browser-page-guest-focus'
import { useBrowserPageWebviewShortcuts } from '../../host-guest/input/use-browser-page-webview-shortcuts'
import { useBrowserPageZoomFeedback } from '../../host-guest/viewport/use-browser-page-zoom-feedback'
import { ClientHostedBrowserLoadFailure } from '../../navigate/client-hosted-browser-load-failure'
import { useClientHostedPageUrlSubmission } from '../../navigate/use-client-hosted-page-url-submission'
import { useWorkspaceDocPageFileDrop } from '../../navigate/browser-page-workspace-file-drop'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { useBrowserPageReloadActions } from '../../navigate/use-browser-page-reload-actions'
import { consumeBrowserPageDeferredNavigation } from '../../navigate/browser-page-deferred-navigation'
import { toDisplayUrl } from '../../describe-page/browser-page-url-display'
import { getBrowserDisplayTitle } from '../../../../../../shared/browser/browser-display-title'
import type { ClientHostedBrowserPagePaneProps as Props } from '../../describe-page/browser-page-types'
import { BROWSER_DEVTOOLS_DOCK_SPLIT_CLASS_NAME } from '../../host-guest/viewport/browser-page-viewport'
import { BrowserDevToolsDock } from '../../devtools-dock/BrowserDevToolsDock'
import { useBrowserDevToolsDockPageFlex } from '../../devtools-dock/browser-devtools-docked-pages'
import { useClientHostedPageSidePanelRoom } from './use-client-hosted-page-side-panel-room'

export function ClientHostedBrowserPagePane(props: Props) {
  const {
    browserTab,
    workspaceId,
    runtimeEnvironmentId,
    worktreeId,
    placement,
    isActive,
    chromeShortcutScope,
    onUpdatePageState,
    onSetUrl
  } = props
  const viewportPresetId = browserTab.viewportPresetId ?? null
  const pageBox = useClientHostedBrowserPageViewport(browserTab.id, viewportPresetId)
  const devToolsPageFlex = useBrowserDevToolsDockPageFlex(browserTab.id)
  const sidePanelRoom = useClientHostedPageSidePanelRoom(browserTab.id)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const viewportContainerRef = useRef<HTMLDivElement | null>(null)
  const dismissAddressBarSuggestionsRef = useRef<(() => void) | null>(null)
  // Seed retained failures from the page: a fresh null on remount would clear both the error and its certificate record.
  const loadFailureRef = useRef<BrowserGuestMetadata['loadError']>(browserTab.loadError ?? null)
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const isActiveRef = useRef(isActive)
  const attach = useClientHostedPageAttachment(browserTab.id, onUpdatePageState)
  const { attachmentError, setAttachmentError, wakeWhenShown, recoverLostGuest } = attach
  const [findOpen, setFindOpen] = useState(false)
  const [paneRoot, setPaneRoot] = useState<HTMLDivElement | null>(null)
  const updatePageStateFromGuest = useEffectEvent(onUpdatePageState)
  const setUrlFromGuest = useEffectEvent(onSetUrl)
  const recordHistoryFromGuest = useEffectEvent(useAppStore((s) => s.addBrowserHistoryEntry))
  const browserHostClientId = placement?.browserHostClientId ?? null
  const browserHostGeneration = placement?.browserHostGeneration ?? null
  const pageHostGeneration = placement?.pageHostGeneration ?? null
  const initialization = useClientHostedPageInitialization(props, attachmentError, loadFailureRef)
  useLayoutEffect(() => {
    onUpdatePageStateRef.current = onUpdatePageState
    isActiveRef.current = isActive
  }, [isActive, onUpdatePageState])

  const guestFocus = useWebviewGuestFocus(webviewRef)
  const shortcutOwner = { browserTabId: browserTab.id, workspaceId, isActive, chromeShortcutScope }
  const { startAddressBarFocusGrab } = useBrowserPageChromeFocus({
    ...shortcutOwner,
    addressBarInputRef,
    guestFocus
  })
  // Resume the edit before attach sync writes the guest URL, or the saved draft is overwritten first.
  const { addressBarValue, setAddressBarValue, setAddressBarValueFromPage, addressBarEditSession } =
    useBrowserAddressBarEditSession({
      pageId: browserTab.id,
      url: browserTab.url,
      addressBarInputRef,
      startAddressBarFocusGrab
    })
  const zoom = useBrowserPageZoomFeedback()
  const reload = useBrowserPageReloadActions({
    browserTab: initialization.reloadPage,
    onInitializationAction: initialization.initializationAction,
    webviewRef,
    retryGuestRecoveryRef: attach.retryGuestRecoveryRef,
    onUpdatePageStateRef
  })

  useBrowserClientHostedPopupNotices(browserTab.id)
  useBrowserClientHostedPermissionNotices(browserTab.id)
  useClientHostedBrowserIntroTour(isActive && !attachmentError && placement !== null)
  useBrowserPageFindShortcuts({ ...shortcutOwner, setFindOpen })
  useBrowserPageWebviewShortcuts({
    ...shortcutOwner,
    isActiveRef,
    webviewRef,
    showBrowserZoomFeedback: zoom.showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest: reload.reloadWebviewOrRecoverGuest
  })

  const navigateToUrl = useClientHostedPageUrlSubmission({
    browserTabId: browserTab.id,
    worktreeId,
    onInitializationAction: initialization.initializationAction,
    webviewRef,
    activeLoadFailureRef: loadFailureRef,
    onUpdatePageState,
    onSetUrl,
    setAddressBarValue
  })
  const runDeferredNavigation = useEffectEvent(navigateToUrl)
  const readCurrentPage = useEffectEvent(() =>
    useAppStore
      .getState()
      .browserPagesByWorkspace[workspaceId]?.find((page) => page.id === browserTab.id)
  )
  const getAgentCursorHost = useCallback(() => webviewRef.current?.parentElement ?? null, [])
  useBrowserAgentCursor(browserTab.id, webviewRef, getAgentCursorHost)
  const fileDrop = useWorkspaceDocPageFileDrop(browserTab.id, worktreeId, pageBox.contentRef)

  const annotate = useClientHostedBrowserAnnotate(
    props,
    initialization,
    webviewRef,
    pageBox.contentRef,
    viewportPresetId ? paneRoot : null
  )
  const bindAnnotationGuest = annotate.bindGuest

  useLayoutEffect(() => {
    const viewport = pageBox.contentRef.current
    if (initialization.suppressAttachment) {
      setAttachmentError(null)
      return
    }
    if (
      !viewport ||
      pageHostGeneration === null ||
      browserHostClientId === null ||
      browserHostGeneration === null
    ) {
      return
    }
    let attachment: ReturnType<typeof attachBrowserClientPageToViewport>
    try {
      attachment = attachBrowserClientPageToViewport(
        { browserPageId: browserTab.id, pageHostGeneration },
        viewport
      )
    } catch (error) {
      const code = error instanceof Error ? error.message : 'browser_client_page_unavailable'
      return wakeWhenShown(viewport, pageHostGeneration, code)
    }
    if (!attachment) {
      return wakeWhenShown(viewport, pageHostGeneration, 'browser_client_page_renderer_unavailable')
    }
    const webview = attachment.webview
    let guestAvailable = true
    let releaseGuest = (): void => attachment.detach()
    const guestLoss = watchBrowserClientPageGuestLoss({
      webview,
      webviewRef,
      browserPageId: browserTab.id,
      pageHostGeneration,
      onLost: () => {
        guestAvailable = false
        releaseGuest()
        recoverLostGuest(viewport, pageHostGeneration)
      }
    })
    const publisher = startBrowserClientPageMetadataPublisher({
      browserPageId: browserTab.id,
      environmentId: runtimeEnvironmentId,
      placement: { kind: 'client', browserHostClientId, browserHostGeneration, pageHostGeneration },
      nextRevision: attachment.nextMetadataRevision,
      faviconUrl: readCurrentPage()?.faviconUrl ?? null
    })
    webviewRef.current = webview
    setAttachmentError(null)
    const receiveMetadata = (state: BrowserGuestMetadata | null): void => {
      if (!state || state.kind === 'retired') {
        guestLoss.lose('unreadable')
        return
      }
      const pending = readCurrentPage()
      if (!pending) {
        guestAvailable = false
        releaseGuest()
        return
      }
      const url = redactKagiSessionToken(state.url)
      const metadata = {
        url,
        title:
          state.title || (url && !isBlankBrowserUrl(url) ? getBrowserDisplayTitle('', url) : url),
        loading: state.loading,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward
      }
      const validDocument =
        Boolean(state.url) && !state.errorPage && !state.loadError && !state.hasCertificateFailure
      const presentDocument =
        validDocument && !browserGuestPreservesRequestedDocument(webview, state.url, pending.url)
      if (
        state.kind === 'navigation' ||
        ((state.kind === 'stop' || (state.kind === 'snapshot' && !state.loading)) && validDocument)
      ) {
        loadFailureRef.current = null
      }
      if (state.loadError) {
        loadFailureRef.current = state.loadError
      }
      const activeLoadFailure = loadFailureRef.current
      const observeUrl =
        presentDocument &&
        !activeLoadFailure &&
        (state.kind === 'navigation' ||
          state.kind === 'in-page' ||
          state.kind === 'stop' ||
          state.kind === 'snapshot')
      if (observeUrl) {
        if (pending.url !== metadata.url) {
          setUrlFromGuest(browserTab.id, metadata.url, { preserveLoadError: true })
        }
        setAddressBarValueFromPage(toDisplayUrl(metadata.url))
      }
      updatePageStateFromGuest(browserTab.id, {
        ...(presentDocument && !activeLoadFailure ? { title: metadata.title } : {}),
        loading: metadata.loading,
        canGoBack: metadata.canGoBack,
        canGoForward: metadata.canGoForward,
        loadError: activeLoadFailure
      })
      const current = readCurrentPage()
      if (!current) {
        return
      }
      publisher.publish({
        ...metadata,
        ...(presentDocument && !activeLoadFailure ? {} : { url: current.url, title: current.title })
      })
      if (observeUrl || (state.kind === 'title' && presentDocument && !activeLoadFailure)) {
        const title = getBrowserDisplayTitle(metadata.title, metadata.url)
        recordHistoryFromGuest(metadata.url, title, current.faviconUrl)
      }
    }
    const onNavigate = (): void => setFindOpen(false)
    webview.addEventListener('did-navigate', onNavigate)
    const unbindChrome = bindBrowserClientPageChromeListeners(webview, {
      browserPageId: browserTab.id,
      updatePageState: (pageId, updates) => updatePageStateFromGuest(pageId, updates),
      publishFavicon: (faviconUrl) => publisher.publishFavicon(faviconUrl),
      dismissAddressBarSuggestions: () => dismissAddressBarSuggestionsRef.current?.(),
      applyViewportPreset: pageBox.applyOverride
    })
    const unbindAnnotationDocument = bindAnnotationGuest(webview)
    const onFailLoad = createBrowserClientPageLoadFailureHandler(webview, (loadError) => {
      loadFailureRef.current = loadError
      updatePageStateFromGuest(browserTab.id, { loading: false, loadError })
    })
    webview.addEventListener('did-fail-load', onFailLoad)
    let unsubscribeMetadata = (): void => {}
    const cleanupGuest = (): void => {
      unsubscribeMetadata()
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('did-navigate', onNavigate)
      unbindChrome()
      unbindAnnotationDocument()
      guestLoss.dispose()
      publisher.dispose()
      forgetBrowserClientPageMetadataReports(browserTab.id)
      attachment.detach()
    }
    releaseGuest = cleanupGuest
    const deferredUrl = consumeBrowserPageDeferredNavigation(browserTab.id)
    if (deferredUrl) {
      runDeferredNavigation(deferredUrl)
    }
    unsubscribeMetadata = subscribeBrowserGuestMetadata(browserTab.id, webview, receiveMetadata)
    if (!guestAvailable) {
      cleanupGuest()
    }
    return cleanupGuest
  }, [
    browserTab.id,
    pageBox.contentRef,
    pageBox.applyOverride,
    initialization.suppressAttachment,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    runtimeEnvironmentId,
    setAddressBarValueFromPage,
    bindAnnotationGuest,
    attach.remountRevision,
    setAttachmentError,
    wakeWhenShown,
    recoverLostGuest
  ])

  return (
    <div
      ref={setPaneRoot}
      className="relative flex h-full min-h-0 flex-1 flex-col bg-background"
      data-browser-page-pane-id={browserTab.id}
    >
      <BrowserPageContextMenu
        browserPageId={browserTab.id}
        worktreeId={worktreeId}
        canGoBack={browserTab.canGoBack}
        canGoForward={browserTab.canGoForward}
        webviewRef={webviewRef}
        onReload={() => reload.reloadWebviewOrRecoverGuest(false)}
        remoteRoutedNetwork
      />
      <div data-contextual-tour-target="client-hosted-browser-controls">
        <ClientHostedBrowserPageToolbar
          browserTab={browserTab}
          workspaceId={workspaceId}
          worktreeId={worktreeId}
          runtimeEnvironmentId={runtimeEnvironmentId}
          isActive={isActive}
          loading={initialization.loading}
          webviewRef={webviewRef}
          reload={reload}
          addressBarValue={addressBarValue}
          setAddressBarValue={setAddressBarValue}
          addressBarEditSession={addressBarEditSession}
          addressBarInputRef={addressBarInputRef}
          dismissAddressBarSuggestionsRef={dismissAddressBarSuggestionsRef}
          navigateToUrl={navigateToUrl}
          annotateTools={annotate.tools}
          onOpenFind={() => setFindOpen(true)}
        />
      </div>
      {annotate.banner}
      <div {...sidePanelRoom} className={BROWSER_DEVTOOLS_DOCK_SPLIT_CLASS_NAME}>
        <div
          ref={viewportContainerRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
          style={devToolsPageFlex === null ? undefined : { flex: devToolsPageFlex }}
          {...fileDrop}
        >
          <ClientHostedBrowserPageBox
            scrollerRef={pageBox.scrollerRef}
            contentRef={pageBox.contentRef}
          >
            {annotate.overlays}
          </ClientHostedBrowserPageBox>
          <ClientHostedBrowserPageOverlays
            browserPageId={browserTab.id}
            isActive={isActive}
            containerRef={viewportContainerRef}
            webviewRef={webviewRef}
            feedbackBadgeRef={zoom.feedbackBadgeRef}
            findOpen={findOpen}
            onCloseFind={() => setFindOpen(false)}
            guestGeneration={pageHostGeneration}
          />
          {initialization.showFailureOverlay ? (
            <ClientHostedBrowserLoadFailure
              browserTab={browserTab}
              isActive={isActive}
              onRetry={() => reload.runReloadTrigger('reload')}
            />
          ) : null}
          <ClientHostedBrowserPageStandIn
            unavailable={initialization.unavailable}
            showNewTab={initialization.showNewTab}
            runtimeEnvironmentId={runtimeEnvironmentId}
            worktreeId={worktreeId}
            browserPageId={browserTab.id}
            reopenUrl={browserTab.url}
            placementHostClientId={browserHostClientId}
            onOpenUrl={navigateToUrl}
          />
        </div>
        {devToolsPageFlex === null ? null : <BrowserDevToolsDock browserPageId={browserTab.id} />}
      </div>
    </div>
  )
}
