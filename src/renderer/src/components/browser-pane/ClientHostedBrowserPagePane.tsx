import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { BrowserPageZoomIndicator } from './assemble-chrome/browser-page-zoom-indicator'
import { BrowserLinkStatusBubble } from './assemble-chrome/browser-link-status-bubble'
import { useAppStore } from '@/store'
import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import {
  readBrowserClientPageGuestMetadataIfLive,
  createBrowserClientPageLoadFailureHandler,
  bindBrowserClientPageGuestEvents
} from './browser-client-page-guest-metadata'
import {
  forgetBrowserClientPageMetadataReports,
  startBrowserClientPageMetadataPublisher
} from './browser-client-page-metadata-reporting'
import { attachBrowserClientPageToViewport } from './browser-client-page-renderer-installation'
import { useBrowserClientHostedPopupNotices } from './browser-client-hosted-popup-notices'
import { useBrowserClientHostedPermissionNotices } from './browser-client-hosted-permission-notices'
import { useClientHostedBrowserIntroTour } from './use-client-hosted-browser-intro-tour'
import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'
import { watchBrowserClientPageGuestLoss } from './host-guest/browser-client-page-guest-loss'
import { useRestoredClientHostedRecoveryWindow } from './restored-client-hosted-recovery-window'
import { useClientHostedBrowserMarkup } from './annotate/use-client-hosted-browser-markup'
import BrowserFind from './assemble-chrome/BrowserFind'
import { BrowserNavigationControlRow } from './assemble-chrome/browser-navigation-control-row'
import BrowserAddressBar from './assemble-chrome/BrowserAddressBar'
import { BrowserPageContextMenu } from './assemble-chrome/browser-page-context-menu'
import { useBrowserPageChromeFocus } from './assemble-chrome/use-browser-page-chrome-focus'
import { useBrowserAddressBarEditSession } from './assemble-chrome/use-browser-address-bar-edit-session'
import { useBrowserPageFindShortcuts } from './assemble-chrome/use-browser-page-find-shortcuts'
import { useWebviewGuestFocus } from './assemble-chrome/browser-page-guest-focus'
import { RemoteRuntimeEgressIndicator } from './assemble-chrome/browser-egress-indicator'
import { getBrowserPageZoomIndicatorState } from './host-guest/browser-page-zoom'
import { useBrowserPageWebviewShortcuts } from './host-guest/use-browser-page-webview-shortcuts'
import { useClientHostedGuestActivationFocus } from './host-guest/use-client-hosted-guest-activation-focus'
import { useBrowserPageZoomFeedback } from './host-guest/use-browser-page-zoom-feedback'
import { isPageDocumentNavigationStart } from './host-guest/browser-page-webview-navigation-handlers'
import { ClientHostedBrowserLoadFailure } from './client-hosted-browser-load-failure'
import { useClientHostedPageUrlSubmission } from './navigate/use-client-hosted-page-url-submission'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { isBlankBrowserUrl } from '@/lib/browser-palette-search'
import { BrowserNewTabPage } from './new-tab/BrowserNewTabPage'
import { useBrowserPageReloadActions } from './navigate/use-browser-page-reload-actions'
import { resolveActiveBrowserLoadFailure } from './navigate/browser-load-failure-for-url'
import { consumeBrowserPageDeferredNavigation } from './navigate/browser-page-deferred-navigation'
import { getBrowserDisplayTitle, toDisplayUrl } from './describe-page/browser-page-url-display'
import type { ClientHostedBrowserPagePaneProps } from './describe-page/browser-page-types'

export function ClientHostedBrowserPagePane({
  browserTab,
  workspaceId,
  runtimeEnvironmentId,
  worktreeId,
  placement,
  isActive,
  chromeShortcutScope,
  onUpdatePageState,
  onSetUrl
}: ClientHostedBrowserPagePaneProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  // Seed retained failures from the page: a fresh null on remount would clear both the error and its certificate record.
  const activeLoadFailureRef = useRef<BrowserLoadError | null>(browserTab.loadError ?? null)
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const isActiveRef = useRef(isActive)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const updatePageStateFromGuest = useEffectEvent(onUpdatePageState)
  const setUrlFromGuest = useEffectEvent(onSetUrl)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const recordHistoryFromGuest = useEffectEvent(addBrowserHistoryEntry)
  const browserHostClientId = placement?.browserHostClientId ?? null
  const browserHostGeneration = placement?.browserHostGeneration ?? null
  const pageHostGeneration = placement?.pageHostGeneration ?? null
  const restoredPageUnrecovered = useRestoredClientHostedRecoveryWindow({
    browserPageId: browserTab.id,
    environmentId: runtimeEnvironmentId,
    placementPending: placement === null
  })
  // Main owns this guest; guest loss requires reopening on the server rather than local recreation.
  const retryGuestRecoveryRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    onUpdatePageStateRef.current = onUpdatePageState
    isActiveRef.current = isActive
    retryGuestRecoveryRef.current = () => {
      onUpdatePageState(browserTab.id, { loading: false })
      setAttachmentError('browser_client_page_guest_unavailable')
    }
  }, [browserTab.id, isActive, onUpdatePageState])

  const guestFocus = useWebviewGuestFocus(webviewRef)
  const shortcutOwner = { browserTabId: browserTab.id, workspaceId, isActive, chromeShortcutScope }
  const { keepAddressBarFocusRef, startAddressBarFocusGrab } = useBrowserPageChromeFocus({
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
    browserTab,
    webviewRef,
    retryGuestRecoveryRef,
    onUpdatePageStateRef
  })

  useBrowserClientHostedPopupNotices(browserTab.id)
  useBrowserClientHostedPermissionNotices(browserTab.id)
  // Only consume the one-time tour after placement and attachment make its controls usable.
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
    webviewRef,
    activeLoadFailureRef,
    onUpdatePageState,
    setAddressBarValue
  })
  const runDeferredNavigation = useEffectEvent(navigateToUrl)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    // Wait for host adoption before attaching an optimistic page the registry has not seen.
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
      setAttachmentError(error instanceof Error ? error.message : 'browser_client_page_unavailable')
      return
    }
    if (!attachment) {
      setAttachmentError('browser_client_page_renderer_unavailable')
      return
    }
    const webview = attachment.webview
    // Guest loss uses the existing recovery notice and clears pending loading state.
    let releaseGuest = (): void => attachment.detach()
    const guestLoss = watchBrowserClientPageGuestLoss({
      webview,
      webviewRef,
      browserPageId: browserTab.id,
      pageHostGeneration,
      onLost: () => {
        releaseGuest()
        retryGuestRecoveryRef.current()
      }
    })
    // Main can destroy the guest while its tag still holds the stale id.
    const attachedMetadata = readBrowserClientPageGuestMetadataIfLive(webview)
    if (!attachedMetadata) {
      guestLoss.lose('unreadable')
      return guestLoss.dispose()
    }
    const publisher = startBrowserClientPageMetadataPublisher({
      browserPageId: browserTab.id,
      environmentId: runtimeEnvironmentId,
      placement: {
        kind: 'client',
        browserHostClientId,
        browserHostGeneration,
        pageHostGeneration
      },
      nextRevision: attachment.nextMetadataRevision
    })
    webviewRef.current = webview
    setAttachmentError(null)
    // Reconcile restored failures once; failed navigations this session may never commit a URL.
    activeLoadFailureRef.current = resolveActiveBrowserLoadFailure(
      activeLoadFailureRef.current,
      attachedMetadata.url
    )
    const syncNavigation = (event?: Event): void => {
      const eventUrl = (event as (Event & { url?: string }) | undefined)?.url
      const metadata = readBrowserClientPageGuestMetadataIfLive(webview, eventUrl)
      if (!metadata) {
        guestLoss.lose('unreadable')
        return
      }
      // A commit is a successful load; did-stop-loading must preserve the preceding did-fail-load overlay.
      if (event?.type === 'did-navigate') {
        activeLoadFailureRef.current = null
      }
      const activeLoadFailure = activeLoadFailureRef.current
      // URL writes clear certificate challenges, so preserve them while a failure stands.
      if (!activeLoadFailure) {
        setUrlFromGuest(browserTab.id, metadata.url, { preserveLoadError: true })
      }
      updatePageStateFromGuest(browserTab.id, {
        title: metadata.title,
        loading: metadata.loading,
        canGoBack: metadata.canGoBack,
        canGoForward: metadata.canGoForward,
        loadError: activeLoadFailure
      })
      publisher.publish(metadata)
      // Address-bar suggestions use the client's URL history, including client-hosted pages.
      recordHistoryFromGuest(metadata.url, getBrowserDisplayTitle(metadata.title, metadata.url))
      setAddressBarValueFromPage(toDisplayUrl(metadata.url))
    }
    const onStart = (event: Electron.DidStartNavigationEvent): void => {
      if (!isPageDocumentNavigationStart(event)) {
        return
      }
      // Why: a standing failure (and its auto-retry) stays up until a load commits or fails anew.
      updatePageStateFromGuest(browserTab.id, { loading: true })
      const startMetadata = readBrowserClientPageGuestMetadataIfLive(webview, undefined, true)
      if (!startMetadata) {
        guestLoss.lose('unreadable')
        return
      }
      publisher.publish(startMetadata)
    }
    const onFailLoad = createBrowserClientPageLoadFailureHandler(
      webview,
      () => guestLoss.lose('unreadable'),
      (loadError) => {
        activeLoadFailureRef.current = loadError
        updatePageStateFromGuest(browserTab.id, { loading: false, loadError })
      }
    )
    const unbind = bindBrowserClientPageGuestEvents(webview, onStart, syncNavigation, onFailLoad)
    const cleanupGuest = (): void => {
      unbind()
      guestLoss.dispose()
      publisher.dispose()
      forgetBrowserClientPageMetadataReports(browserTab.id)
      attachment.detach()
    }
    releaseGuest = cleanupGuest
    syncNavigation()
    // Resume navigation submitted before host adoption.
    const deferredUrl = consumeBrowserPageDeferredNavigation(browserTab.id)
    if (deferredUrl) {
      runDeferredNavigation(deferredUrl)
    }
    return cleanupGuest
  }, [
    browserTab.id,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    runtimeEnvironmentId,
    setAddressBarValueFromPage
  ])

  useClientHostedGuestActivationFocus({ isActive, guestFocus, keepAddressBarFocusRef })

  const showFailureOverlay = !attachmentError && Boolean(browserTab.loadError)
  const browserZoomIndicatorState = getBrowserPageZoomIndicatorState({
    feedbackVisible: zoom.browserZoomFeedbackVisible
  })

  const markup = useClientHostedBrowserMarkup({
    webviewRef,
    browserPageId: browserTab.id,
    runtimeEnvironmentId,
    placement,
    isActive,
    unavailable: Boolean(attachmentError) || restoredPageUnrecovered,
    showFailureOverlay
  })

  // Unrecovered pages have no pending load that could ever clear a loading indicator.
  const loading = !restoredPageUnrecovered && (placement === null || browserTab.loading)

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col bg-background"
      data-browser-page-pane-id={browserTab.id}
    >
      {/* IPC-driven context menu in a Portal so position:fixed escapes ancestor transform/backdrop-filter containing blocks. */}
      <BrowserPageContextMenu
        browserPageId={browserTab.id}
        worktreeId={worktreeId}
        canGoBack={browserTab.canGoBack}
        canGoForward={browserTab.canGoForward}
        webviewRef={webviewRef}
        onReload={() => reload.reloadWebviewOrRecoverGuest(false)}
      />
      <div data-contextual-tour-target="client-hosted-browser-controls">
        <BrowserNavigationControlRow
          controls={{
            canGoBack: browserTab.canGoBack,
            canGoForward: browserTab.canGoForward,
            goBack: () => webviewRef.current?.goBack(),
            goForward: () => webviewRef.current?.goForward(),
            reload: () => reload.runReloadTrigger('button'),
            navigate: navigateToUrl
          }}
          addressSlot={
            <BrowserAddressBar
              pageId={browserTab.id}
              value={addressBarValue}
              onChange={setAddressBarValue}
              onSubmit={() => navigateToUrl(addressBarValue)}
              onNavigate={navigateToUrl}
              onOpenWorkspaceDoc={(docLocation) =>
                convertBrowserPageToWorkspaceDoc(browserTab.id, docLocation)
              }
              inputRef={addressBarInputRef}
              editSession={addressBarEditSession}
              leadingIcon={
                <RemoteRuntimeEgressIndicator
                  runtimeEnvironmentId={runtimeEnvironmentId}
                  presentation="client-hosted"
                />
              }
              loading={loading}
              loadFailed={browserTab.loadError !== null}
            />
          }
          reloadLabel={reload.reloadButtonLabel}
          reloadShowsStop={reload.reloadButtonLabelKind === 'stop'}
        >
          {markup.drawButton}
        </BrowserNavigationControlRow>
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {markup.overlay}
        <BrowserPageZoomIndicator
          state={browserZoomIndicatorState}
          percent={zoom.browserZoomPercent}
        />
        <BrowserFind
          isOpen={findOpen}
          onClose={() => setFindOpen(false)}
          webviewRef={webviewRef}
          guestGeneration={pageHostGeneration}
        />
        <BrowserLinkStatusBubble browserPageId={browserTab.id} />
        {showFailureOverlay ? (
          <ClientHostedBrowserLoadFailure
            browserTab={browserTab}
            isActive={isActive}
            onRetry={() => reload.runReloadTrigger('reload')}
          />
        ) : null}
        {attachmentError || restoredPageUnrecovered ? (
          <ClientHostedBrowserUnavailableNotice
            runtimeEnvironmentId={runtimeEnvironmentId}
            worktreeId={worktreeId}
            lastCommittedUrl={browserTab.url}
            placementHostClientId={browserHostClientId}
          />
        ) : isBlankBrowserUrl(browserTab.url) ? (
          <BrowserNewTabPage worktreeId={worktreeId} onOpenUrl={navigateToUrl} serversElsewhere />
        ) : null}
      </div>
    </div>
  )
}
