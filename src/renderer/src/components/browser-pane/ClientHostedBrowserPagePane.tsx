import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { useBrowserAgentCursor } from './agent-cursor/use-browser-agent-cursor'
import { BrowserPageFeedbackBadge } from './assemble-chrome/browser-page-feedback-badge'
import { BrowserLinkStatusBubble } from './assemble-chrome/browser-link-status-bubble'
import { useAppStore } from '@/store'
import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import { createBrowserClientPageLoadFailureHandler } from './browser-client-page-guest-metadata'
import { subscribeBrowserGuestMetadata } from './host-guest/browser-guest-metadata-cache'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
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
import { useBrowserPageWebviewShortcuts } from './host-guest/use-browser-page-webview-shortcuts'
import { useBrowserPageZoomFeedback } from './host-guest/use-browser-page-zoom-feedback'
import { ClientHostedBrowserLoadFailure } from './client-hosted-browser-load-failure'
import { useClientHostedPageUrlSubmission } from './navigate/use-client-hosted-page-url-submission'
import '@/lib/browser/documents/file-preview'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { BrowserNewTabPage } from './new-tab/BrowserNewTabPage'
import { useBrowserPageReloadActions } from './navigate/use-browser-page-reload-actions'
import { consumeBrowserPageDeferredNavigation } from './navigate/browser-page-deferred-navigation'
import { getBrowserDisplayTitle, toDisplayUrl } from './describe-page/browser-page-url-display'
import type { ClientHostedBrowserPagePaneProps } from './describe-page/browser-page-types'
import { BROWSER_DEVTOOLS_DOCK_SPLIT_CLASS_NAME } from './host-guest/browser-page-viewport'
import { BrowserDevToolsDock } from './devtools-dock/BrowserDevToolsDock'
import { useBrowserDevToolsDockPageFlex } from './devtools-dock/browser-devtools-docked-pages'

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
  const devToolsPageFlex = useBrowserDevToolsDockPageFlex(browserTab.id)
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
    browserTab,
    webviewRef,
    retryGuestRecoveryRef,
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
    webviewRef,
    activeLoadFailureRef,
    onUpdatePageState,
    setAddressBarValue
  })
  const runDeferredNavigation = useEffectEvent(navigateToUrl)
  const readPendingPageMetadata = useEffectEvent(() => ({
    url: browserTab.url,
    title: browserTab.title,
    loading: browserTab.loading
  }))
  // The guest lives in a body-level host that paints above the pane, so the cursor joins it there.
  const getAgentCursorHost = useCallback(
    () => webviewRef.current?.parentElement ?? null,
    [webviewRef]
  )
  useBrowserAgentCursor(browserTab.id, webviewRef, getAgentCursorHost)

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
        retryGuestRecoveryRef.current()
      }
    })
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
    let appliedUrl: string | null = null
    const receiveMetadata = (state: BrowserGuestMetadata | null): void => {
      if (!state || state.kind === 'retired') {
        guestLoss.lose('unreadable')
        return
      }
      const metadata = {
        url: redactKagiSessionToken(state.url || 'about:blank'),
        title: state.title,
        loading: state.loading,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward
      }
      if (
        state.kind === 'navigation' ||
        ((state.kind === 'stop' || (state.kind === 'snapshot' && !state.loading)) &&
          state.navigationRevision > 0 &&
          !state.loadError &&
          !state.hasCertificateFailure &&
          !state.errorPage)
      ) {
        activeLoadFailureRef.current = null
      }
      if (state.kind === 'navigation') {
        setFindOpen(false)
      }
      if (state.loadError) {
        activeLoadFailureRef.current = state.loadError
      }
      const activeLoadFailure = activeLoadFailureRef.current
      const observeUrl =
        state.navigationRevision > 0 &&
        !state.errorPage &&
        !state.loadError &&
        !state.hasCertificateFailure &&
        (state.kind === 'navigation' ||
          state.kind === 'in-page' ||
          state.kind === 'stop' ||
          (state.kind === 'snapshot' && state.navigationRevision > 0 && !state.loading))
      if (observeUrl && !activeLoadFailure) {
        if (appliedUrl !== metadata.url) {
          appliedUrl = metadata.url
          setUrlFromGuest(browserTab.id, metadata.url, { preserveLoadError: true })
        }
        setAddressBarValueFromPage(toDisplayUrl(metadata.url))
      }
      updatePageStateFromGuest(browserTab.id, {
        ...(state.navigationRevision > 0 ? { title: metadata.title } : {}),
        ...(state.kind === 'snapshot' && state.navigationRevision === 0
          ? {}
          : { loading: metadata.loading }),
        canGoBack: metadata.canGoBack,
        canGoForward: metadata.canGoForward,
        loadError: activeLoadFailure
      })
      if (state.navigationRevision > 0) {
        publisher.publish(metadata)
      } else if (state.kind !== 'title') {
        const pending = readPendingPageMetadata()
        publisher.publish({
          ...metadata,
          ...pending,
          loading: state.kind === 'snapshot' ? pending.loading : state.loading
        })
      }
      if (observeUrl || state.kind === 'title') {
        recordHistoryFromGuest(metadata.url, getBrowserDisplayTitle(metadata.title, metadata.url))
      }
    }
    const onFailLoad = createBrowserClientPageLoadFailureHandler(webview, (loadError) => {
      activeLoadFailureRef.current = loadError
      updatePageStateFromGuest(browserTab.id, { loading: false, loadError })
    })
    webview.addEventListener('did-fail-load', onFailLoad)
    let unsubscribeMetadata = (): void => {}
    const cleanupGuest = (): void => {
      unsubscribeMetadata()
      webview.removeEventListener('did-fail-load', onFailLoad)
      guestLoss.dispose()
      publisher.dispose()
      forgetBrowserClientPageMetadataReports(browserTab.id)
      attachment.detach()
    }
    releaseGuest = cleanupGuest
    unsubscribeMetadata = subscribeBrowserGuestMetadata(browserTab.id, webview, receiveMetadata)
    if (!guestAvailable) {
      cleanupGuest()
      return cleanupGuest
    }
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

  const showFailureOverlay = !attachmentError && Boolean(browserTab.loadError)

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
      <div className={BROWSER_DEVTOOLS_DOCK_SPLIT_CLASS_NAME}>
        <div
          ref={viewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
          style={devToolsPageFlex === null ? undefined : { flex: devToolsPageFlex }}
        >
          {markup.overlay}
          <BrowserPageFeedbackBadge ref={zoom.feedbackBadgeRef} />
          <BrowserFind
            browserPageId={browserTab.id}
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
        {devToolsPageFlex === null ? null : <BrowserDevToolsDock browserPageId={browserTab.id} />}
      </div>
    </div>
  )
}
