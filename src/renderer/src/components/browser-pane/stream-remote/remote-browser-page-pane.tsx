import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import { useBrowserPageChromeFocus } from '../assemble-chrome/use-browser-page-chrome-focus'
import { useBrowserAddressBarEditSession } from '../assemble-chrome/use-browser-address-bar-edit-session'
import { useElementGuestFocus } from '../assemble-chrome/browser-page-guest-focus'
import { consumeBrowserPageDeferredNavigation } from '../navigate/browser-page-deferred-navigation'
import { useMarkupMode, type MarkupCaptureContext } from '../annotate/useMarkupMode'
import { deliverMarkupToClipboard } from '../annotate/markup-clipboard-delivery'
import {
  isRemoteBrowserStreamBusy,
  remoteBrowserStreamNotice
} from './remote-browser-stream-status'
import type {
  BrowserChromeShortcutScope,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'
import type { RemoteBrowserPaneNotice } from './remote-browser-page-input-model'
import { useRemoteBrowserPageLifecycle } from './use-remote-browser-page-lifecycle'
import { useRemoteBrowserPageStream } from './use-remote-browser-page-stream'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import {
  useRemoteBrowserPageInput,
  useRemoteBrowserPageInputQueue
} from './use-remote-browser-page-input'
import { useRemoteBrowserPageChromeChords } from './use-remote-browser-page-chrome-chords'
import { useRemoteBrowserPageWheel } from './use-remote-browser-page-wheel'
import {
  RemoteBrowserPageContextMenu,
  useRemoteBrowserPageContextMenu
} from './remote-browser-page-context-menu'
import { RemoteBrowserPageToolbar } from './remote-browser-page-toolbar'
import { RemoteBrowserPageViewport } from './remote-browser-page-viewport'

export function RemoteBrowserPagePane({
  browserTab,
  workspaceId,
  runtimeEnvironmentId,
  worktreeId,
  isActive,
  chromeShortcutScope,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  workspaceId: string
  runtimeEnvironmentId: string
  worktreeId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
}): React.JSX.Element {
  const activeRuntimeEnvironmentId = runtimeEnvironmentId
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const remoteViewportRef = useRef<HTMLDivElement | null>(null)
  // Why: the screencast <img> only exists once a frame lands, so before the first one the
  // viewport is the only place guest focus can go.
  const guestFocus = useElementGuestFocus(imageRef, remoteViewportRef)
  const { startAddressBarFocusGrab } = useBrowserPageChromeFocus({
    browserTabId: browserTab.id,
    workspaceId,
    isActive,
    chromeShortcutScope,
    addressBarInputRef,
    guestFocus
  })
  const { addressBarValue, setAddressBarValue, setAddressBarValueFromPage, addressBarEditSession } =
    useBrowserAddressBarEditSession({
      pageId: browserTab.id,
      url: browserTab.url,
      addressBarInputRef,
      startAddressBarFocusGrab
    })
  // Pane-owned notices, split by what they are ABOUT, because that decides who outranks whom:
  //
  //   'direct'      — feedback on what the user just did (URL validation). Always shown: it is the
  //                   only response to their action, and suppressing it makes Enter look broken.
  //   'consequence' — an operation that failed BECAUSE the stream is down (input, navigation RPCs).
  //                   Outranked by the stream's own notice, which explains the cause; otherwise
  //                   these repaint raw transport text over it on every stray click.
  //
  // Kept as one slot so the newest notice replaces the previous one, as a single toast should.
  const [paneNotice, setPaneNotice] = useState<RemoteBrowserPaneNotice | null>(null)
  const [paneBusy, setPaneBusy] = useState(false)
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const remotePageHandle = useAppStore(
    (s) => s.remoteBrowserPageHandlesByPageId[browserTab.id] ?? null
  )
  const stagedPage = remotePageHandle?.staged === true

  // Why: runtimes predating browser.certificate-trust.v1 can't honor a proceed request, so hide "Proceed Anyway" until support is advertised.
  const [remoteCertificateTrustSupported, setRemoteCertificateTrustSupported] = useState(false)
  const remoteCertificateEnvironmentId = remotePageHandle?.environmentId ?? null
  const certificateChallengeId = certificateFailure?.challengeId ?? null
  useEffect(() => {
    if (!remoteCertificateEnvironmentId || !certificateChallengeId) {
      setRemoteCertificateTrustSupported(false)
      return
    }
    let cancelled = false
    void runtimeEnvironmentSupportsCapability(
      remoteCertificateEnvironmentId,
      BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled) {
          setRemoteCertificateTrustSupported(supported)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteCertificateTrustSupported(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [remoteCertificateEnvironmentId, certificateChallengeId])

  const {
    enqueueRemoteInput,
    clearPendingRemoteWheel,
    resetRemoteInputQueue,
    pendingRemoteWheelRef,
    remoteWheelFrameRef,
    remoteWheelInFlightRef
  } = useRemoteBrowserPageInputQueue()

  const {
    lifecycle,
    streamStatus,
    frameUrl,
    frameMetadata,
    runtimeWorktree,
    runtimeTarget,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    clearStreamFrame,
    closeMissingRemotePage,
    mountedRef,
    isActiveRef,
    streamBridgeRef,
    streamFrameUrlRef,
    pendingFrameDecodeRef,
    remoteViewportSizeRef,
    remoteCssViewportSizeRef,
    remoteViewportTimerRef,
    setFrameUrl,
    setFrameMetadata
  } = useRemoteBrowserPageLifecycle({
    browserTab,
    worktreeId,
    activeRuntimeEnvironmentId,
    isActive,
    setPaneNotice,
    setPaneBusy,
    clearPendingRemoteWheel,
    resetRemoteInputQueue
  })

  // Derived, never stored. The stream's own notice wins over an incidental one: while the stream is
  // down every input RPC fails as a matter of course, and those failures must not overwrite the
  // message that explains why — nor can the reconnect control depend on one of them being present.
  // A stopped stream delivers no frames that could clear paneBusy, so it must force busy off.
  // A staged page has no stream to report on yet; its create is the thing still in progress.
  const busy = stagedPage
    ? true
    : streamStatus.kind === 'stopped'
      ? false
      : paneBusy || isRemoteBrowserStreamBusy(streamStatus)
  const streamNotice = remoteBrowserStreamNotice(streamStatus)
  const remoteError =
    paneNotice?.kind === 'direct' ? paneNotice.text : (streamNotice ?? paneNotice?.text ?? null)

  const {
    applyRemoteTabInfo,
    scheduleRemoteTabInfoRefresh,
    runRemoteNavigation,
    navigateToUrl,
    submitAddressBar
  } = useRemoteBrowserPageNavigation({
    browserTab,
    isActive,
    stagedPage,
    addressBarValue,
    setAddressBarValueFromPage,
    lifecycle,
    runtimeWorktree,
    runtimeTarget,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage,
    onSetUrl,
    onUpdatePageState,
    setPaneNotice,
    setPaneBusy
  })

  // Why: a URL submitted against a staged page was parked rather than sent to a host page that did
  // not exist. This pane keeps the page when the host is headless, so it owns the replay.
  useEffect(() => {
    if (stagedPage) {
      return
    }
    const deferredUrl = consumeBrowserPageDeferredNavigation(browserTab.id)
    if (deferredUrl) {
      navigateToUrl(deferredUrl)
    }
  }, [browserTab.id, navigateToUrl, stagedPage])

  useRemoteBrowserPageChromeChords({
    chromeShortcutScope,
    workspaceId,
    runRemoteNavigation,
    setPaneNotice
  })

  // Why: focus given to the pane before the first frame can only land on the viewport, but the
  // screencast <img> is what carries key input — hand it over as soon as there is one.
  const hasStreamFrame = frameUrl !== null
  useEffect(() => {
    if (!hasStreamFrame || document.activeElement !== remoteViewportRef.current) {
      return
    }
    imageRef.current?.focus()
  }, [hasStreamFrame])

  const { reconnectRemoteStream } = useRemoteBrowserPageStream({
    activeRuntimeEnvironmentId,
    browserPageId: browserTab.id,
    isActive,
    lifecycle,
    stagedPage,
    runtimeWorktree,
    runtimeTarget,
    remoteViewportRef,
    remoteViewportSizeRef,
    remoteCssViewportSizeRef,
    remoteViewportTimerRef,
    streamFrameUrlRef,
    pendingFrameDecodeRef,
    streamBridgeRef,
    isActiveRef,
    applyTabInfo: applyRemoteTabInfo,
    clearStreamFrame,
    closeMissingRemotePage,
    clearPendingRemoteWheel,
    setPaneNotice,
    setPaneBusy,
    setFrameUrl,
    setFrameMetadata
  })

  const {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemoteScreenshotKeyDown
  } = useRemoteBrowserPageInput({
    busy,
    imageRef,
    remoteViewportRef,
    remoteCssViewportSizeRef,
    remoteViewportSizeRef,
    frameMetadata,
    runtimeTarget,
    lifecycle,
    runtimeWorktree,
    enqueueRemoteInput,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage,
    scheduleRemoteTabInfoRefresh,
    setPaneNotice
  })

  useRemoteBrowserPageWheel({
    busy,
    imageRef,
    remoteViewportRef,
    frameUrl,
    runtimeTarget,
    lifecycle,
    runtimeWorktree,
    getRemoteImagePoint,
    enqueueRemoteInput,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage,
    scheduleRemoteTabInfoRefresh,
    setPaneNotice,
    pendingRemoteWheelRef,
    remoteWheelFrameRef,
    remoteWheelInFlightRef
  })

  const { contextMenu, setContextMenu, handleRemoteContextMenu } = useRemoteBrowserPageContextMenu({
    busy,
    browserTabUrl: browserTab.url,
    imageRef,
    runtimeTarget,
    lifecycle,
    runtimeWorktree,
    getRemoteImagePoint,
    enqueueRemoteInput,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage,
    mountedRef,
    setPaneNotice
  })

  // Why: markup snapshots the displayed screencast <img> (no injection), so it works on remote panes even though element-grab doesn't.
  const markup = useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const element = imageRef.current
      const container = remoteViewportRef.current
      if (!element || !container) {
        return null
      }
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: { kind: 'image', element },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, []),
    onDeliver: deliverMarkupToClipboard
  })

  return (
    // The testid scopes E2E queries to this pane: a workspace can hold more than one browser pane,
    // and controls like the address bar are otherwise ambiguous across them.
    <div
      data-testid="remote-browser-pane"
      className="relative flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      {contextMenu ? (
        <RemoteBrowserPageContextMenu
          contextMenu={contextMenu}
          onDismiss={() => setContextMenu(null)}
          onOpenLinkInOrcaBrowser={() => {
            const linkUrl = contextMenu.linkUrl!
            setContextMenu(null)
            void openWorkspaceBrowserTab({
              workspaceId: worktreeId,
              url: linkUrl,
              intent: { kind: 'url' },
              expectedRuntimeEnvironmentId: runtimeEnvironmentId
            }).catch((error) => {
              setPaneNotice({
                kind: 'direct',
                text: error instanceof Error ? error.message : String(error)
              })
            })
          }}
          onNavigate={(method) => {
            void runRemoteNavigation(method)
            setContextMenu(null)
          }}
        />
      ) : null}
      <RemoteBrowserPageToolbar
        runtimeEnvironmentId={runtimeEnvironmentId}
        addressBarValue={addressBarValue}
        onAddressBarChange={setAddressBarValue}
        onSubmitAddressBar={submitAddressBar}
        onNavigateToUrl={navigateToUrl}
        addressBarInputRef={addressBarInputRef}
        addressBarEditSession={addressBarEditSession}
        busy={busy}
        loading={browserTab.loading}
        markup={markup}
        frameUrl={frameUrl}
        isActive={isActive}
        onBack={() => void runRemoteNavigation('browser.back')}
        onForward={() => void runRemoteNavigation('browser.forward')}
        onReload={() => void runRemoteNavigation('browser.reload')}
      />
      <RemoteBrowserPageViewport
        remoteViewportRef={remoteViewportRef}
        imageRef={imageRef}
        frameUrl={frameUrl}
        frameMetadata={frameMetadata}
        busy={busy}
        markup={markup}
        browserTab={browserTab}
        remoteError={remoteError}
        streamStatus={streamStatus}
        remoteCertificateTrustSupported={remoteCertificateTrustSupported}
        certificateFailure={certificateFailure}
        remotePageHandle={remotePageHandle}
        activeRuntimeEnvironmentId={activeRuntimeEnvironmentId}
        worktreeId={worktreeId}
        runtimeWorktree={runtimeWorktree}
        runtimeTarget={runtimeTarget}
        onReload={() => void runRemoteNavigation('browser.reload')}
        onGoto={(url) => void runRemoteNavigation('browser.goto', url)}
        onReconnect={reconnectRemoteStream}
        handleRemotePointerDown={handleRemotePointerDown}
        handleRemotePointerUp={handleRemotePointerUp}
        handleRemoteContextMenu={handleRemoteContextMenu}
        handleRemoteScreenshotKeyDown={handleRemoteScreenshotKeyDown}
      />
    </div>
  )
}
