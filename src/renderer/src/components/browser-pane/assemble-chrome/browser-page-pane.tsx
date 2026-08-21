import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import { normalizeExternalBrowserUrl } from '../../../../../shared/browser-url'
import { getLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import { ensureBrowserPageViewport } from '../host-guest/browser-page-viewport'
import { isBrowserPagePanePaintable } from '../host-guest/browser-page-paintability'
import { getShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import { useGrabMode } from '../annotate/useGrabMode'
import { getBrowserPageZoomIndicatorState } from '../host-guest/browser-page-zoom'
import { getOpenableExternalUrl, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import type {
  BrowserFindShortcutScope,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'
import { BrowserPageChromeHeader } from './browser-page-chrome-header'
import { BrowserPageContextMenu } from './browser-page-context-menu'
import { BrowserPageViewportOverlays } from './browser-page-viewport-overlays'
import { useBrowserPageAnnotationSend } from '../annotate/use-browser-page-annotation-send'
import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'
import { useBrowserPageFindShortcuts } from './use-browser-page-find-shortcuts'
import { useBrowserPageGrabAnnotations } from '../annotate/use-browser-page-grab-annotations'
import { useBrowserPageKeyboardShortcuts } from '../host-guest/use-browser-page-keyboard-shortcuts'
import { useBrowserPageMarkupCapture } from '../annotate/use-browser-page-markup-capture'
import { useBrowserPageNavigationDownloads } from '../navigate/use-browser-page-navigation-downloads'
import { useBrowserPageReloadActions } from '../navigate/use-browser-page-reload-actions'
import { useBrowserPageResourceNotices } from '../navigate/use-browser-page-resource-notices'
import { useBrowserPageSlotViewport } from '../host-guest/use-browser-page-slot-viewport'
import { useBrowserPageWebviewLifecycle } from '../host-guest/use-browser-page-webview-lifecycle'
import { useBrowserPageWebviewPartition } from '../host-guest/use-browser-page-webview-partition'
import { useBrowserPageWebviewUrlSync } from '../navigate/use-browser-page-webview-url-sync'
import { useBrowserPageZoomFeedback } from '../host-guest/use-browser-page-zoom-feedback'

export function BrowserPagePane({
  browserTab,
  workspaceId,
  worktreeId,
  sessionProfileId,
  sessionPartition,
  isActive,
  findShortcutScope,
  isAutomationVisible,
  isMobileDriven,
  inputLocked,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  sessionPartition: string | null
  isActive: boolean
  findShortcutScope: BrowserFindShortcutScope
  isAutomationVisible: boolean
  isMobileDriven: boolean
  inputLocked: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
}): React.JSX.Element {
  const isPaintable = isBrowserPagePanePaintable({
    isActive,
    isAutomationVisible,
    isMobileDriven
  })
  const pageViewport = ensureBrowserPageViewport(browserTab.id, workspaceId)
  const pageViewportContainer = pageViewport?.container ?? null
  const containerRef = useRef<HTMLDivElement | null>(pageViewportContainer)
  useLayoutEffect(() => {
    containerRef.current = pageViewportContainer
  }, [pageViewportContainer])
  const chromeHeaderRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const dismissAddressBarSuggestionsRef = useRef<(() => void) | null>(null)
  const addressBarValueRef = useRef(browserTab.url)
  const browserTabUrlRef = useRef(browserTab.url)
  const keepAddressBarFocusRef = useRef(false)
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
  const grabElementShortcut = useShortcutLabel('browser.grabElement')
  const slotViewport = useBrowserPageSlotViewport(workspaceId)

  const zoom = useBrowserPageZoomFeedback(browserTab.id)
  const { resourceNotice, setResourceNotice } = useBrowserPageResourceNotices(browserTab.id)
  const { focusAddressBarNow, focusWebviewNow } = useBrowserPageChromeFocus({
    browserTabId: browserTab.id,
    isActive,
    addressBarInputRef,
    webviewRef,
    keepAddressBarFocusRef
  })
  const annotationSend = useBrowserPageAnnotationSend({
    browserTabId: browserTab.id,
    worktreeId
  })
  const grab = useGrabMode(browserTab.id)
  const markup = useBrowserPageMarkupCapture(webviewRef, containerRef)
  const grabAnnotations = useBrowserPageGrabAnnotations({
    browserTabId: browserTab.id,
    isActive,
    grab,
    containerRef,
    webviewRef,
    setBrowserOverlayViewport,
    browserAnnotationsLength: annotationSend.browserAnnotations.length,
    setBrowserAnnotationTrayOpen: annotationSend.setBrowserAnnotationTrayOpen
  })
  const nav = useBrowserPageNavigationDownloads({
    browserTabId: browserTab.id,
    worktreeId,
    webviewRef,
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
  useBrowserPageWebviewLifecycle({
    browserTabId: browserTab.id,
    browserTabUrl: browserTab.url,
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
    setPendingAnnotationPayload: grabAnnotations.setPendingAnnotationPayload,
    setBrowserOverlayViewport,
    setFindOpen,
    focusAddressBarNow,
    focusWebviewNow,
    paneZoomLevelRef: zoom.paneZoomLevelRef,
    setBrowserZoomPercent: zoom.setBrowserZoomPercent,
    pendingAnnotationPayload: grabAnnotations.pendingAnnotationPayload,
    browserAnnotationsLength: annotationSend.browserAnnotations.length,
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
    retryGuestRecoveryRef,
    onUpdatePageStateRef
  })
  useBrowserPageFindShortcuts({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    findShortcutScope,
    setFindOpen
  })
  useBrowserPageKeyboardShortcuts({
    browserTabId: browserTab.id,
    isActive,
    isActiveRef,
    markupIsActive: markup.isActive,
    webviewRef,
    paneZoomLevelRef: zoom.paneZoomLevelRef,
    setBrowserDefaultZoomLevel: zoom.setBrowserDefaultZoomLevel,
    showBrowserZoomFeedback: zoom.showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest: reload.reloadWebviewOrRecoverGuest,
    startGrabIntent: grabAnnotations.startGrabIntent,
    focusAddressBarNow,
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

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: Electron webviews keep receiving native input under a React overlay unless their own hit testing is disabled.
    webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
  }, [inputLocked])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: some Electron builds keep painting a hidden guest layer, so drop it from layout (display:none) instead of just hiding it.
    webview.style.display = showFailureOverlay ? 'none' : 'flex'
  }, [showFailureOverlay])

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
        webviewRef={webviewRef}
        onReload={() => reload.reloadWebviewOrRecoverGuest(false)}
      />
      <BrowserPageChromeHeader
        chromeHeaderRef={chromeHeaderRef}
        browserTab={browserTab}
        workspaceId={workspaceId}
        worktreeId={worktreeId}
        sessionProfileId={sessionProfileId}
        isActive={isActive}
        webviewRef={webviewRef}
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
      {pageViewport?.container
        ? createPortal(
            <BrowserPageViewportOverlays
              markup={markup}
              browserZoomIndicatorState={browserZoomIndicatorState}
              browserZoomPercent={zoom.browserZoomPercent}
              findOpen={findOpen}
              setFindOpen={setFindOpen}
              webviewRef={webviewRef}
              showFailureOverlay={showFailureOverlay}
              browserTab={browserTab}
              failureExternalUrl={failureExternalUrl}
              failedNavigationUrl={failedNavigationUrl}
              onUpdatePageStateRef={onUpdatePageStateRef}
              retryGuestRecoveryRef={retryGuestRecoveryRef}
              navigateToUrl={nav.navigateToUrl}
              setResourceNotice={setResourceNotice}
              certificateFailure={certificateFailure}
              isBlankTab={isBlankTab}
              containerRef={containerRef}
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
