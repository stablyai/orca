import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  BrowserLoadError,
  BrowserPage as BrowserPageState
} from '../../../../shared/browser-workspace-types'
import { redactKagiSessionToken, toHttpsRecoveryUrl } from '../../../../shared/browser-url'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { readBrowserClientPageGuestMetadata } from './browser-client-page-guest-metadata'
import {
  forgetBrowserClientPageMetadataReports,
  startBrowserClientPageMetadataPublisher
} from './browser-client-page-metadata-reporting'
import { attachBrowserClientPageToViewport } from './browser-client-page-renderer-installation'
import { useBrowserClientHostedDownloadNotices } from './browser-client-hosted-download-notices'
import { useBrowserClientHostedPopupNotices } from './browser-client-hosted-popup-notices'
import { useBrowserClientHostedPermissionNotices } from './browser-client-hosted-permission-notices'
import { useClientHostedBrowserIntroTour } from './use-client-hosted-browser-intro-tour'
import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'
import { useRestoredClientHostedRecoveryWindow } from './restored-client-hosted-recovery-window'
import BrowserFind from './assemble-chrome/BrowserFind'
import { BrowserNavigationControlRow } from './assemble-chrome/browser-navigation-control-row'
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
import { BrowserLoadFailureOverlay } from './navigate/browser-load-failure-overlay'
import { resolveBrowserAddressBarSubmission } from './navigate/browser-address-bar-navigation'
import { useBrowserPageReloadActions } from './navigate/use-browser-page-reload-actions'
import { resolveBrowserWebviewLoadFailure } from './navigate/browser-webview-load-failure'
import { resolveActiveBrowserLoadFailure } from './navigate/browser-load-failure-for-url'
import {
  consumeBrowserPageDeferredNavigation,
  deferBrowserPageNavigation
} from './navigate/browser-page-deferred-navigation'
import {
  getBrowserDisplayTitle,
  getOpenableExternalUrl,
  toDisplayUrl
} from './describe-page/browser-page-url-display'
import type {
  BrowserChromeShortcutScope,
  BrowserPageFailLoadEvent,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from './describe-page/browser-page-types'

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
}: {
  browserTab: BrowserPageState
  workspaceId: string
  runtimeEnvironmentId: string
  worktreeId: string
  /** Null while the tab is still an optimistic stage: the host mints the placement, not this client. */
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  // Why: a worktree switch unmounts this pane while main keeps the guest, so the failure has to
  // be seeded from the stored page — a fresh null here reads as "no failure" and the next sync
  // writes that back, which also deletes the page's certificate record.
  const activeLoadFailureRef = useRef<BrowserLoadError | null>(browserTab.loadError ?? null)
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const isActiveRef = useRef(isActive)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const updatePageStateFromGuest = useEffectEvent(onUpdatePageState)
  const setUrlFromGuest = useEffectEvent(onSetUrl)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const recordHistoryFromGuest = useEffectEvent(addBrowserHistoryEntry)
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const browserHostClientId = placement?.browserHostClientId ?? null
  const browserHostGeneration = placement?.browserHostGeneration ?? null
  const pageHostGeneration = placement?.pageHostGeneration ?? null
  const restoredPageUnrecovered = useRestoredClientHostedRecoveryWindow({
    browserPageId: browserTab.id,
    environmentId: runtimeEnvironmentId,
    placementPending: placement === null
  })
  // Why: a client-hosted guest is created by main's host runtime, so there is no local guest to
  // recreate — a lost one is page unavailability, whose panel offers the reopen-on-server escape.
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
  const { keepAddressBarFocusRef, startAddressBarFocusGrab } = useBrowserPageChromeFocus({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    addressBarInputRef,
    guestFocus
  })
  // Why the order matters: this resumes an interrupted edit in a layout effect, and the attach
  // effect below syncs the bar to the guest's URL through the setter it hands back. Called after
  // the attach effect, the resume would land on a bar that has already been overwritten.
  const { addressBarValue, setAddressBarValue, setAddressBarValueFromPage, addressBarEditSession } =
    useBrowserAddressBarEditSession({
      pageId: browserTab.id,
      url: browserTab.url,
      addressBarInputRef,
      startAddressBarFocusGrab
    })
  const zoom = useBrowserPageZoomFeedback(browserTab.id)
  const reload = useBrowserPageReloadActions({
    browserTab,
    webviewRef,
    retryGuestRecoveryRef,
    onUpdatePageStateRef
  })

  useBrowserClientHostedDownloadNotices(browserTab.id)
  useBrowserClientHostedPopupNotices(browserTab.id)
  useBrowserClientHostedPermissionNotices(browserTab.id)
  // Why: the tour points at controls that cannot work yet, and recording the interaction is a
  // one-way write that would burn the tour on a pane the user has not really seen.
  useClientHostedBrowserIntroTour(isActive && !attachmentError && placement !== null)
  useBrowserPageFindShortcuts({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    setFindOpen
  })
  useBrowserPageWebviewShortcuts({
    browserTabId: browserTab.id,
    isActive,
    isActiveRef,
    webviewRef,
    paneZoomLevelRef: zoom.paneZoomLevelRef,
    setBrowserDefaultZoomLevel: zoom.setBrowserDefaultZoomLevel,
    showBrowserZoomFeedback: zoom.showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest: reload.reloadWebviewOrRecoverGuest
  })

  const navigateToUrl = useCallback(
    (value: string) => {
      const submission = resolveBrowserAddressBarSubmission(value)
      if (submission.status === 'invalid') {
        onUpdatePageState(browserTab.id, { loadError: submission.loadError })
        return
      }
      const webview = webviewRef.current
      if (!webview) {
        // Why: the page is still an optimistic stage, so park the URL for the attach effect to
        // replay rather than dropping what the user just typed.
        deferBrowserPageNavigation(browserTab.id, submission.url)
        setAddressBarValue(toDisplayUrl(redactKagiSessionToken(submission.url)))
        return
      }
      // Why: the store and the address bar must never hold a Kagi session token, and an optimistic
      // title keeps the tab from reading "New Tab" until the guest reports one — as local does.
      const browserModelUrl = redactKagiSessionToken(submission.url)
      activeLoadFailureRef.current = null
      setAddressBarValue(toDisplayUrl(browserModelUrl))
      onUpdatePageState(browserTab.id, {
        loading: true,
        loadError: null,
        title: getBrowserDisplayTitle(browserModelUrl, browserModelUrl)
      })
      // Why: loadURL rejects on any failed navigation; did-fail-load owns error reporting.
      void webview.loadURL(submission.url).catch(() => {})
    },
    [browserTab.id, onUpdatePageState, setAddressBarValue]
  )
  const runDeferredNavigation = useEffectEvent(navigateToUrl)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    // Why: no placement means the host has not minted this page yet. Attaching would throw for an
    // id the retained registry has never seen and strand the pane on the unavailable notice, whose
    // only exit is reopening on the server — so mount quiet and wait for adoption to supply it.
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
    // Why: the failure carried in from the store is hearsay — this pane may be remounting over a
    // guest that navigated on while nothing was listening — so it is checked once against where
    // the guest actually is. Failures this session observes are trusted as they arrive, because a
    // navigation that fails outright often never commits and leaves the guest on the old URL.
    activeLoadFailureRef.current = resolveActiveBrowserLoadFailure(
      activeLoadFailureRef.current,
      readBrowserClientPageGuestMetadata(webview).url
    )
    const syncNavigation = (event?: Event): void => {
      const eventUrl = (event as (Event & { url?: string }) | undefined)?.url
      const metadata = readBrowserClientPageGuestMetadata(webview, eventUrl)
      // Why: did-stop-loading fires after did-fail-load, so an unconditional null here would
      // wipe the failure the overlay is about to show.
      const activeLoadFailure = activeLoadFailureRef.current
      // Why: a URL write drops the page's certificate challenge by design (challenges are
      // transient across navigation), so a standing failure must not run through one — the
      // local pane returns before its own setUrl for the same reason.
      if (!activeLoadFailure) {
        setUrlFromGuest(browserTab.id, metadata.url, {
          preserveLoadError: true
        })
      }
      updatePageStateFromGuest(browserTab.id, {
        title: metadata.title,
        loading: metadata.loading,
        canGoBack: metadata.canGoBack,
        canGoForward: metadata.canGoForward,
        loadError: activeLoadFailure
      })
      publisher.publish(metadata)
      // Why: the address bar's suggestions read the client's shared URL history, so a page
      // hosted here has to file its navigations there like a local guest does.
      recordHistoryFromGuest(metadata.url, getBrowserDisplayTitle(webview.getTitle(), metadata.url))
      setAddressBarValueFromPage(toDisplayUrl(metadata.url))
    }
    const onStart = (): void => {
      activeLoadFailureRef.current = null
      updatePageStateFromGuest(browserTab.id, { loading: true, loadError: null })
      publisher.publish(readBrowserClientPageGuestMetadata(webview, undefined, true))
    }
    const onFailLoad = (event: Event): void => {
      const loadError = resolveBrowserWebviewLoadFailure(event as BrowserPageFailLoadEvent, {
        fallbackUrl: webview.getURL()
      })
      if (!loadError) {
        return
      }
      activeLoadFailureRef.current = loadError
      updatePageStateFromGuest(browserTab.id, { loading: false, loadError })
    }
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', syncNavigation)
    webview.addEventListener('did-navigate', syncNavigation)
    webview.addEventListener('did-navigate-in-page', syncNavigation)
    webview.addEventListener('page-title-updated', syncNavigation)
    webview.addEventListener('did-fail-load', onFailLoad)
    syncNavigation()
    // Why: the user pressed Enter while this page was still an optimistic stage, so the navigation
    // was parked rather than sent to a host page that did not exist yet. The guest exists now.
    const deferredUrl = consumeBrowserPageDeferredNavigation(browserTab.id)
    if (deferredUrl) {
      runDeferredNavigation(deferredUrl)
    }
    return () => {
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', syncNavigation)
      webview.removeEventListener('did-navigate', syncNavigation)
      webview.removeEventListener('did-navigate-in-page', syncNavigation)
      webview.removeEventListener('page-title-updated', syncNavigation)
      webview.removeEventListener('did-fail-load', onFailLoad)
      if (webviewRef.current === webview) {
        webviewRef.current = null
      }
      publisher.dispose()
      forgetBrowserClientPageMetadataReports(browserTab.id)
      attachment.detach()
    }
  }, [
    browserTab.id,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    runtimeEnvironmentId,
    setAddressBarValueFromPage
  ])

  useClientHostedGuestActivationFocus({ isActive, webviewRef, keepAddressBarFocusRef })

  const showFailureOverlay = !attachmentError && Boolean(browserTab.loadError)
  // Why: the failure is about the URL that failed, not whatever page is still loaded — feeding
  // browserTab.url here named the previous page and offered it an HTTPS retry it never needed.
  const failedNavigationUrl = browserTab.loadError?.validatedUrl ?? toDisplayUrl(browserTab.url)
  const browserZoomIndicatorState = getBrowserPageZoomIndicatorState({
    feedbackVisible: zoom.browserZoomFeedbackVisible,
    isDefaultZoom: zoom.browserZoomPercent === zoom.browserDefaultZoomPercent
  })

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: the retained guest is a body-level fixed host painted over this pane's viewport, so a
    // React overlay inside the viewport cannot cover it — drop the guest from layout instead.
    webview.style.display = showFailureOverlay || attachmentError ? 'none' : 'flex'
  }, [attachmentError, showFailureOverlay])

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background">
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
            // Why the unrecovered case reads not-loading: nothing is coming, and a spinner nobody
            // will ever stop is the one state this pane must not sit in.
            loading: !restoredPageUnrecovered && (placement === null || browserTab.loading),
            goBack: () => webviewRef.current?.goBack(),
            goForward: () => webviewRef.current?.goForward(),
            reload: () => reload.runReloadTrigger('button'),
            navigate: navigateToUrl
          }}
          addressBarValue={addressBarValue}
          onAddressBarChange={setAddressBarValue}
          onSubmitAddressBar={() => navigateToUrl(addressBarValue)}
          addressBarInputRef={addressBarInputRef}
          addressBarEditSession={addressBarEditSession}
          reloadLabel={reload.reloadButtonLabel}
          addressBarLeadingIcon={
            <RemoteRuntimeEgressIndicator
              runtimeEnvironmentId={runtimeEnvironmentId}
              presentation="client-hosted"
            />
          }
        />
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div
          role="status"
          aria-live="polite"
          aria-hidden={browserZoomIndicatorState.ariaHidden}
          className={cn(
            'pointer-events-none absolute top-3 right-3 z-30 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-xs transition-opacity duration-300 ease-out',
            browserZoomIndicatorState.opacityClassName
          )}
        >
          {zoom.browserZoomPercent}%
        </div>
        <BrowserFind
          isOpen={findOpen}
          onClose={() => setFindOpen(false)}
          webviewRef={webviewRef}
          guestGeneration={pageHostGeneration}
        />
        {showFailureOverlay && browserTab.loadError ? (
          <BrowserLoadFailureOverlay
            loadError={browserTab.loadError}
            currentUrl={toDisplayUrl(failedNavigationUrl)}
            httpsRecoveryUrl={toHttpsRecoveryUrl(failedNavigationUrl)}
            onRetry={() => reload.runReloadTrigger('reload')}
            onTryHttps={navigateToUrl}
            onCopy={(url) => void window.api.ui.writeClipboardText(url)}
            onOpenExternal={(url) => void window.api.shell.openUrl(url)}
            externalUrl={getOpenableExternalUrl(failedNavigationUrl)}
            certificateFailure={certificateFailure}
            expectedBrowserPageId={browserTab.id}
            // Why: the guest is a local Electron webview on this desktop, so its certificate
            // decision is a local session decision — the same IPC the local pane proceeds through.
            onProceedCertificate={(challengeId) =>
              window.api.browser.proceedCertificate({
                browserPageId: browserTab.id,
                challengeId
              })
            }
          />
        ) : null}
        {attachmentError || restoredPageUnrecovered ? (
          <ClientHostedBrowserUnavailableNotice
            runtimeEnvironmentId={runtimeEnvironmentId}
            worktreeId={worktreeId}
            lastCommittedUrl={browserTab.url}
          />
        ) : null}
      </div>
    </div>
  )
}
