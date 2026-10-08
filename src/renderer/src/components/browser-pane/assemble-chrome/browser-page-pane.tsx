import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { normalizeExternalBrowserUrl } from '../../../../../shared/browser-url'
import { getLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import { isBrowserPagePanePaintable } from '../host-guest/browser-page-paintability'
import { getShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import { useGrabMode } from '../annotate/useGrabMode'
import { getBrowserPageZoomIndicatorState } from '../host-guest/browser-page-zoom'
import { getOpenableExternalUrl, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import type { BrowserPagePaneProps } from '../describe-page/browser-page-types'
import { BrowserPageChromeHeader } from './browser-page-chrome-header'
import { BrowserPageContextMenu } from './browser-page-context-menu'
import { BrowserPageViewportOverlays } from './browser-page-viewport-overlays'
import { useBrowserPageAnnotationSend } from '../annotate/use-browser-page-annotation-send'
import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'
import { useElementGuestFocus, useWebviewGuestFocus } from './browser-page-guest-focus'
import { useBrowserPageFindShortcuts } from './use-browser-page-find-shortcuts'
import { useBrowserPageGrabAnnotations } from '../annotate/use-browser-page-grab-annotations'
import { useBrowserPageKeyboardShortcuts } from '../host-guest/use-browser-page-keyboard-shortcuts'
import { useBrowserPageMarkupCapture } from '../annotate/use-browser-page-markup-capture'
import { useBrowserPageNavigationDownloads } from '../navigate/use-browser-page-navigation-downloads'
import { useBrowserPageReloadActions } from '../navigate/use-browser-page-reload-actions'
import { useBrowserPageResourceNotices } from '../navigate/use-browser-page-resource-notices'
import { useBrowserPageWebviewLifecycle } from '../host-guest/use-browser-page-webview-lifecycle'
import { useBrowserPageWebviewPartition } from '../host-guest/use-browser-page-webview-partition'
import { useBrowserPageWebviewUrlSync } from '../navigate/use-browser-page-webview-url-sync'
import { useBrowserPageZoomFeedback } from '../host-guest/use-browser-page-zoom-feedback'
import { useBrowserPageViewport } from '../host-guest/use-browser-page-viewport'
import { createWebviewBrowserPageSurface } from '../host-guest/browser-page-webview-surface'
import { useBrowserPageWebviewPresentation } from '../host-guest/use-browser-page-webview-presentation'
import { useDesktopBrowserPage } from '../host-guest/use-desktop-browser-page'
import { useDesktopBrowserPageLifecycle } from '../host-guest/use-desktop-browser-page-lifecycle'
import { DesktopBrowserPagePresenter } from '../host-guest/desktop-browser-page-presenter'

export function BrowserPagePane({
  browserTab,
  workspaceId,
  worktreeId,
  sessionProfileId,
  sessionPartition,
  isActive,
  chromeShortcutScope,
  isAutomationVisible,
  isMobileDriven,
  isRemotelyViewed,
  inputLocked,
  onUpdatePageState,
  onSetUrl
}: BrowserPagePaneProps): React.JSX.Element {
  const isPaintable = isBrowserPagePanePaintable({
    isActive,
    isAutomationVisible,
    isMobileDriven,
    hasRemoteViewer: isRemotelyViewed
  })
  const { pageViewport, containerRef, slotViewport } = useBrowserPageViewport(
    browserTab.id,
    workspaceId,
    browserTab.viewportPresetId ?? null
  )
  const chromeHeaderRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const webviewSurface = useMemo(() => createWebviewBrowserPageSurface(webviewRef), [])
  const desktopFocusRef = useRef<HTMLElement | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const dismissAddressBarSuggestionsRef = useRef<(() => void) | null>(null)
  const addressBarValueRef = useRef(browserTab.url)
  const browserTabUrlRef = useRef(browserTab.url)
  // Most-recent observed webview URL; URL sync checks it to avoid force-navigating to an intermediate redirect (which would loop the redirect chain).
  const lastKnownWebviewUrlRef = useRef<string | null>(null)
  const trackNextLoadingEventRef = useRef(false)
  const recoveryNavigationValidationRef = useRef<{
    committed: boolean
    started: boolean
    targetUrl: string
  } | null>(null)
  const activeLoadFailureRef = useRef(browserTab.loadError)
  const retryGuestRecoveryRef = useRef<() => void>(() => {})
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const onSetUrlRef = useRef(onSetUrl)
  const isActiveRef = useRef(isActive)
  useLayoutEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])
  const [findOpen, setFindOpen] = useState(false)
  const [browserOverlayViewport, setBrowserOverlayViewport] = useState<BrowserOverlayViewport>({
    scrollX: 0,
    scrollY: 0,
    version: 0
  })

  const workspaceConnectionId = useAppStore((state) => getConnectionIdFromState(state, worktreeId))
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const webviewPartition = useBrowserPageWebviewPartition({
    sessionProfileId,
    sessionPartition
  })
  const desktopApi =
    browserTab.desktopBackend === 'owned-view' ? window.api.browser.desktopView : undefined
  const desktop = useDesktopBrowserPage(desktopApi, {
    browserPageId: browserTab.id,
    workspaceId,
    worktreeId,
    sessionProfileId,
    url: browserTab.url
  })
  const surface = desktop.page?.surface ?? webviewSurface
  const grabElementShortcut = useShortcutLabel('browser.grabElement')

  const zoom = useBrowserPageZoomFeedback(browserTab.id)
  const { resourceNotice, setResourceNotice } = useBrowserPageResourceNotices(browserTab.id)
  const webviewGuestFocus = useWebviewGuestFocus(webviewRef)
  const desktopGuestFocus = useElementGuestFocus(desktopFocusRef)
  const guestFocus = desktopApi ? desktopGuestFocus : webviewGuestFocus
  const {
    focusAddressBarNow,
    focusGuestNow: focusWebviewNow,
    keepAddressBarFocusRef
  } = useBrowserPageChromeFocus({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    addressBarInputRef,
    guestFocus
  })
  const annotationSend = useBrowserPageAnnotationSend({
    browserTabId: browserTab.id,
    worktreeId
  })
  const grab = useGrabMode(browserTab.id)
  const markup = useBrowserPageMarkupCapture(webviewRef, surface)
  const grabAnnotations = useBrowserPageGrabAnnotations({
    browserTabId: browserTab.id,
    isActive,
    grab,
    containerRef,
    trackingContainer: pageViewport?.container ?? null,
    trackingScroller: pageViewport?.scroller ?? null,
    webviewRef,
    surface,
    setBrowserOverlayViewport,
    browserAnnotationsLength: annotationSend.browserAnnotations.length,
    setBrowserAnnotationTrayOpen: annotationSend.setBrowserAnnotationTrayOpen
  })
  const nav = useBrowserPageNavigationDownloads({
    browserTabId: browserTab.id,
    worktreeId,
    webviewRef,
    surface,
    retryGuestRecoveryRef,
    activeLoadFailureRef,
    lastKnownWebviewUrlRef,
    trackNextLoadingEventRef,
    recoveryNavigationValidationRef,
    onSetUrlRef,
    onUpdatePageStateRef,
    keepAddressBarFocusRef,
    focusWebviewNow,
    setResourceNotice,
    addressBarValueRef,
    addressBarInputRef,
    browserTabUrl: browserTab.url
  })
  const lifecycleOptions = {
    enabled: !desktopApi,
    browserTabId: browserTab.id,
    browserTabUrl: browserTab.url,
    browserTabLoading: browserTab.loading,
    browserTabLoadError: browserTab.loadError,
    workspaceId,
    worktreeId,
    sessionProfileId,
    webviewPartition,
    isActive,
    isPaintable,
    slotViewport,
    viewportPresetId: browserTab.viewportPresetId ?? null,
    addressBarInputRef,
    addressBarValueRef,
    browserTabUrlRef,
    keepAddressBarFocusRef,
    handleInternalFileDragOverRef: nav.handleInternalFileDragOverRef,
    handleInternalFileDropRef: nav.handleInternalFileDropRef,
    dismissAddressBarSuggestionsRef,
    onUpdatePageState,
    onSetUrl,
    setAddressBarValue: nav.setAddressBarValue,
    cancelPendingBrowserCapture: grabAnnotations.cancelPendingBrowserCapture,
    setBrowserOverlayViewport,
    setFindOpen,
    focusAddressBarNow,
    focusWebviewNow,
    paneZoomLevelRef: zoom.paneZoomLevelRef,
    setBrowserZoomPercent: zoom.setBrowserZoomPercent,
    pendingAnnotationPayload: grabAnnotations.pendingAnnotationPayload,
    inputLocked,
    faviconUrl: browserTab.faviconUrl,
    webviewRef,
    lastKnownWebviewUrlRef,
    trackNextLoadingEventRef,
    recoveryNavigationValidationRef,
    activeLoadFailureRef,
    retryGuestRecoveryRef,
    onUpdatePageStateRef,
    onSetUrlRef
  }
  const annotationBridge = useBrowserPageWebviewLifecycle(lifecycleOptions)
  useDesktopBrowserPageLifecycle({
    enabled: Boolean(desktopApi),
    page: desktop.page,
    error: desktop.error,
    recover: desktop.recover,
    options: lifecycleOptions,
    annotations: annotationBridge
  })
  useBrowserPageWebviewUrlSync({
    browserTabId: browserTab.id,
    browserTabUrl: browserTab.url,
    browserTabLoading: browserTab.loading,
    isActive,
    isPaintable,
    slotViewport,
    webviewRef,
    chromeHeaderRef,
    lastKnownWebviewUrlRef,
    trackNextLoadingEventRef,
    keepAddressBarFocusRef,
    addressBarInputRef,
    browserTabUrlRef,
    addressBarValueRef,
    onUpdatePageStateRef,
    focusWebviewNow
  })
  const reload = useBrowserPageReloadActions({
    browserTab,
    webviewRef,
    surface,
    trackNextLoadingEventRef,
    retryGuestRecoveryRef,
    onUpdatePageStateRef
  })
  useBrowserPageFindShortcuts({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    setFindOpen
  })
  useBrowserPageKeyboardShortcuts({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    isActiveRef,
    markupIsActive: markup.isActive,
    surface,
    paneZoomLevelRef: zoom.paneZoomLevelRef,
    setBrowserDefaultZoomLevel: zoom.setBrowserDefaultZoomLevel,
    showBrowserZoomFeedback: zoom.showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest: reload.reloadWebviewOrRecoverGuest,
    startGrabIntent: grabAnnotations.startGrabIntent,
    handleGrabActionShortcut: grabAnnotations.handleGrabActionShortcut,
    grabIsInteractive: grab.state !== 'idle' && grab.state !== 'error'
  })

  // Why: a blank tab reads as 'about:blank' or the resolved data: URL, so match both to keep the "New Browser Tab" overlay visible.
  const isBlankTab = browserTab.url === 'about:blank' || browserTab.url === ORCA_BROWSER_BLANK_URL
  // Why: synchronous webview URL access blocks render; navigation handlers update this cache before their store writes can re-render the pane.
  const liveBrowserUrl = getLiveBrowserUrl(browserTab.id) ?? browserTab.url
  const externalUrl = getOpenableExternalUrl(liveBrowserUrl)
  const currentBrowserUrl = toDisplayUrl(liveBrowserUrl)
  const shareableArtifactFile =
    workspaceConnectionId === null ? getShareableBrowserArtifactFile(currentBrowserUrl) : null
  const failedNavigationUrl = browserTab.loadError?.validatedUrl ?? currentBrowserUrl
  const failureExternalUrl = normalizeExternalBrowserUrl(failedNavigationUrl)
  const showFailureOverlay = Boolean(browserTab.loadError) && !isBlankTab
  const browserZoomIndicatorState = getBrowserPageZoomIndicatorState({
    feedbackVisible: zoom.browserZoomFeedbackVisible,
    isDefaultZoom: zoom.browserZoomPercent === zoom.browserDefaultZoomPercent
  })

  useBrowserPageWebviewPresentation(webviewRef, inputLocked, showFailureOverlay)

  return (
    <div
      data-browser-page-pane-id={browserTab.id}
      className={cn(
        'absolute inset-0 flex min-h-0 flex-1 flex-col',
        isActive
          ? 'pointer-events-none z-10'
          : isPaintable
            ? 'pointer-events-none z-0 opacity-0'
            : 'pointer-events-none hidden'
      )}
      // Why: hidden panes stay paintable (automation/mobile) but must not stay keyboard-focusable.
      inert={!isActive}
      aria-hidden={!isActive}
    >
      {/* IPC-driven context menu in a Portal so position:fixed escapes ancestor transform/backdrop-filter containing blocks. */}
      <BrowserPageContextMenu
        browserPageId={browserTab.id}
        worktreeId={worktreeId}
        canGoBack={browserTab.canGoBack}
        canGoForward={browserTab.canGoForward}
        surface={surface}
        onReload={() => reload.reloadWebviewOrRecoverGuest(false)}
      />
      <BrowserPageChromeHeader
        chromeHeaderRef={chromeHeaderRef}
        browserTab={browserTab}
        workspaceId={workspaceId}
        worktreeId={worktreeId}
        sessionProfileId={sessionProfileId}
        isActive={isActive}
        surface={surface}
        addressBarInputRef={addressBarInputRef}
        dismissAddressBarSuggestionsRef={dismissAddressBarSuggestionsRef}
        reload={reload}
        nav={nav}
        grab={grab}
        grabAnnotations={grabAnnotations}
        annotationSend={annotationSend}
        markupIsActive={markup.isActive}
        markupStart={markup.start}
        markupCancel={markup.cancel}
        grabElementShortcut={grabElementShortcut}
        shareableArtifactFile={shareableArtifactFile}
        currentBrowserUrl={currentBrowserUrl}
        externalUrl={externalUrl}
        isBlankTab={isBlankTab}
        resourceNotice={resourceNotice}
        setResourceNotice={setResourceNotice}
      />
      {desktop.page && pageViewport
        ? createPortal(
            <DesktopBrowserPagePresenter
              page={desktop.page}
              content={pageViewport.content}
              scroller={pageViewport.scroller}
              focusRef={desktopFocusRef}
              state={{
                active: isActive,
                inputLocked,
                hidden: showFailureOverlay || isBlankTab || markup.isActive
              }}
              onDragOver={(event) => nav.handleInternalFileDragOverRef.current(event)}
              onDrop={(event) => nav.handleInternalFileDropRef.current(event)}
            />,
            pageViewport.content
          )
        : null}
      {pageViewport?.container
        ? createPortal(
            <BrowserPageViewportOverlays
              markup={markup}
              browserZoomIndicatorState={browserZoomIndicatorState}
              browserZoomPercent={zoom.browserZoomPercent}
              findOpen={findOpen}
              setFindOpen={setFindOpen}
              webviewRef={webviewRef}
              surface={surface}
              showFailureOverlay={showFailureOverlay}
              browserTab={browserTab}
              failureExternalUrl={failureExternalUrl}
              failedNavigationUrl={failedNavigationUrl}
              onUpdatePageStateRef={onUpdatePageStateRef}
              retryGuestRecoveryRef={retryGuestRecoveryRef}
              navigateToUrl={nav.navigateToUrl}
              setResourceNotice={setResourceNotice}
              certificateFailure={certificateFailure}
              sshRouted={Boolean(sessionPartition?.startsWith('persist:orca-browser-v1-'))}
              isBlankTab={isBlankTab}
              containerRef={containerRef}
              markupPortalContainer={pageViewport?.content ?? null}
              browserOverlayViewport={browserOverlayViewport}
              worktreeId={worktreeId}
              grab={grab}
              annotationSend={annotationSend}
              grabAnnotations={grabAnnotations}
            />,
            pageViewport.container
          )
        : null}
    </div>
  )
}
