import { resolveRemoteFailureExternalUrl } from '../../../../../shared/browser/navigation/browser-url'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  BROWSER_TAB_HISTORY_STATE_RUNTIME_CAPABILITY,
  BROWSER_GRAB_RUNTIME_CAPABILITY
} from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import '@/lib/browser/documents/file-preview'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'
import { useBrowserPageChromeFocus } from '../assemble-chrome/focus/use-browser-page-chrome-focus'
import { useBrowserAddressBarEditSession } from '../assemble-chrome/address-bar/use-browser-address-bar-edit-session'
import { useElementGuestFocus } from '../assemble-chrome/focus/browser-page-guest-focus'
import { consumeBrowserPageDeferredNavigation } from '../navigate/browser-page-deferred-navigation'
import {
  isRemoteBrowserStreamBusy,
  remoteBrowserStreamNotice
} from './remote-browser-stream-status'
import type {
  BrowserChromeShortcutScope,
  BrowserPageUrlSetter,
  BrowserPageStateWriter
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
import { useRemoteBrowserPagePointerHistory } from './use-remote-browser-page-pointer-history'
import { useRemoteBrowserPageWheel } from './use-remote-browser-page-wheel'
import { useRemoteBrowserPageZoom } from './use-remote-browser-page-zoom'
import {
  RemoteBrowserPageContextMenu,
  useRemoteBrowserPageContextMenu
} from './remote-browser-page-context-menu'
import { RemoteBrowserPageToolbar } from './remote-browser-page-toolbar'
import { RemoteBrowserPageViewport } from './remote-browser-page-viewport'
import { useRemoteBrowserPageAnnotate } from './use-remote-browser-page-annotate'

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
  onUpdatePageState: BrowserPageStateWriter
  onSetUrl: BrowserPageUrlSetter
}): React.JSX.Element {
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const remoteViewportRef = useRef<HTMLDivElement | null>(null)
  // Before the first frame creates the image, the viewport is the only guest-focus target.
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
  // Direct action feedback must remain visible; stream failures outrank consequent RPC failures. Keep one slot so newer pane notices replace older ones.
  const [paneNotice, setPaneNotice] = useState<RemoteBrowserPaneNotice | null>(null)
  const [paneBusy, setPaneBusy] = useState(false)
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const remotePageHandle = useAppStore(
    (s) => s.remoteBrowserPageHandlesByPageId[browserTab.id] ?? null
  )
  const stagedPage = remotePageHandle?.staged === true
  // Older hosts publish canGoBack/canGoForward as always false; keep both arrows enabled for them.
  const historyStateKnown = useRuntimeEnvironmentCapability(
    runtimeEnvironmentId,
    BROWSER_TAB_HISTORY_STATE_RUNTIME_CAPABILITY
  )
  const history = historyStateKnown ? browserTab : { canGoBack: true, canGoForward: true }

  const { inputQueue, enqueueRemoteInput, clearPendingRemoteInput, resetRemoteInputQueue } =
    useRemoteBrowserPageInputQueue()

  const {
    lifecycle,
    streamStatus,
    frameUrl,
    frameMetadata,
    pagePointer,
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
    activeRuntimeEnvironmentId: runtimeEnvironmentId,
    isActive,
    setPaneNotice,
    setPaneBusy,
    clearPendingRemoteInput,
    resetRemoteInputQueue
  })
  const grabSupported = useRuntimeEnvironmentCapability(
    remotePageHandle?.environmentId,
    BROWSER_GRAB_RUNTIME_CAPABILITY
  )

  // Stopped streams cannot clear paneBusy with frames; staged pages remain busy until creation. Stream notices outrank consequent RPC failures.
  const busy = stagedPage
    ? true
    : streamStatus.kind === 'stopped'
      ? false
      : paneBusy || isRemoteBrowserStreamBusy(streamStatus)
  const streamNotice = remoteBrowserStreamNotice(streamStatus)
  const remoteError =
    paneNotice?.kind === 'direct' ? paneNotice.text : (streamNotice ?? paneNotice?.text ?? null)

  const remotePageTarget = {
    runtimeTarget,
    lifecycle,
    runtimeWorktree,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage
  }

  const {
    applyRemoteTabInfo,
    abandonRemoteNavigation,
    stopRemotePage,
    scheduleRemoteTabInfoRefresh,
    runRemoteNavigation,
    navigateToUrl,
    submitAddressBar
  } = useRemoteBrowserPageNavigation({
    ...remotePageTarget,
    browserTab,
    stagedPage,
    addressBarValue,
    setAddressBarValueFromPage,
    onSetUrl,
    onUpdatePageState,
    setPaneNotice,
    setPaneBusy
  })

  // Replay staged navigation here when the headless host leaves this pane owning the page.
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
  useRemoteBrowserPagePointerHistory({ isActive, remoteViewportRef, runRemoteNavigation })

  const { reconnectRemoteStream, resyncRemoteViewport } = useRemoteBrowserPageStream({
    activeRuntimeEnvironmentId: runtimeEnvironmentId,
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
    clearPendingRemoteInput,
    setPaneNotice,
    setPaneBusy,
    setFrameUrl,
    setFrameMetadata
  })

  const {
    markup,
    pickerAvailable,
    annotateTools,
    annotateBanner,
    annotateOverlays,
    pagePointerOwned
  } = useRemoteBrowserPageAnnotate({
    browserTab,
    workspaceId,
    worktreeId,
    isActive,
    chromeShortcutScope,
    busy,
    frameUrl,
    stagedPage,
    grabSupported,
    imageRef,
    remoteViewportRef,
    runtimeEnvironmentId,
    remotePageId:
      remotePageHandle?.environmentId === runtimeEnvironmentId
        ? remotePageHandle.remotePageId
        : null,
    runtimeTarget,
    runtimeWorktree,
    lifecycle,
    inputQueue
  })

  const {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemotePointerMove,
    handleRemoteScreenshotKeyDown,
    handleRemoteScreenshotPaste,
    runRemoteEditCommand
  } = useRemoteBrowserPageInput({
    ...remotePageTarget,
    busy,
    pickerAvailable,
    pagePointerOwned,
    inputQueue,
    imageRef,
    remoteViewportRef,
    remoteCssViewportSizeRef,
    remoteViewportSizeRef,
    frameMetadata,
    enqueueRemoteInput,
    scheduleRemoteTabInfoRefresh,
    setPaneNotice
  })

  const zoom = useRemoteBrowserPageZoom({
    ...remotePageTarget,
    browserPageId: browserTab.id,
    runtimeEnvironmentId,
    onZoomed: resyncRemoteViewport,
    setPaneNotice
  })
  useRemoteBrowserPageWheel({
    ...remotePageTarget,
    busy,
    imageRef,
    remoteViewportRef,
    frameUrl,
    getRemoteImagePoint,
    inputQueue,
    scheduleRemoteTabInfoRefresh,
    setPaneNotice,
    requestZoom: zoom.requestZoom
  })

  const { contextMenu, setContextMenu, handleRemoteContextMenu } = useRemoteBrowserPageContextMenu({
    ...remotePageTarget,
    busy,
    pagePointerOwned,
    browserTabUrl: browserTab.url,
    imageRef,
    getRemoteImagePoint,
    enqueueRemoteInput,
    mountedRef,
    setPaneNotice
  })

  return (
    // Scope E2E controls per pane; a workspace may have several address bars.
    <div
      data-testid="remote-browser-pane"
      // Zoom chords follow this attribute to the page; hosts without browser.zoom keep Orca's zoom.
      data-browser-page-pane-id={zoom.requestZoom ? browserTab.id : undefined}
      className="relative flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      {contextMenu ? (
        <RemoteBrowserPageContextMenu
          contextMenu={contextMenu}
          onDismiss={() => {
            setContextMenu(null)
            // Keys reach the page only through the frame, so edits like Select All need it focused again.
            imageRef.current?.focus()
          }}
          history={history}
          actions={{
            edit: runRemoteEditCommand,
            openInNewTab: (url, activate) => {
              const sourceUnifiedTab = resolveBrowserSourceUnifiedTab(
                useAppStore.getState(),
                browserTab.id,
                worktreeId
              )
              void openWorkspaceBrowserTab({
                workspaceId: worktreeId,
                url,
                ...(sourceUnifiedTab ? { afterTabId: sourceUnifiedTab.id } : {}),
                focusOnCreate: activate,
                selectWorktree: false,
                intent: { kind: 'url' },
                expectedRuntimeEnvironmentId: runtimeEnvironmentId,
                placementPreference: 'server'
              }).catch((error) => {
                setPaneNotice({
                  kind: 'direct',
                  text: error instanceof Error ? error.message : String(error)
                })
              })
            },
            // The server's loopback address would open this machine's, not the page's.
            externalUrl: resolveRemoteFailureExternalUrl,
            goBack: () => void runRemoteNavigation('browser.back'),
            goForward: () => void runRemoteNavigation('browser.forward'),
            reload: () => void runRemoteNavigation('browser.reload')
          }}
        />
      ) : null}
      <RemoteBrowserPageToolbar
        runtimeEnvironmentId={runtimeEnvironmentId}
        addressBarValue={addressBarValue}
        onAddressBarChange={setAddressBarValue}
        onSubmitAddressBar={submitAddressBar}
        onNavigateToUrl={navigateToUrl}
        onOpenWorkspaceDoc={(docLocation) =>
          convertBrowserPageToWorkspaceDoc(browserTab.id, docLocation)
        }
        addressBarInputRef={addressBarInputRef}
        addressBarEditSession={addressBarEditSession}
        busy={busy}
        loading={browserTab.loading}
        loadErrorCode={browserTab.loadError?.code ?? null}
        history={history}
        pickerAvailable={pickerAvailable}
        annotateTools={annotateTools}
        onBack={() => void runRemoteNavigation('browser.back')}
        onForward={() => void runRemoteNavigation('browser.forward')}
        onReload={(ignoreCache) =>
          void runRemoteNavigation('browser.reload', undefined, ignoreCache)
        }
        onStop={() => void stopRemotePage()}
      />
      {annotateBanner}
      <RemoteBrowserPageViewport
        remoteViewportRef={remoteViewportRef}
        imageRef={imageRef}
        feedbackBadgeRef={zoom.feedbackBadgeRef}
        frameUrl={frameUrl}
        frameMetadata={frameMetadata}
        pagePointer={pagePointer}
        busy={busy}
        markup={markup}
        browserTab={browserTab}
        remoteError={remoteError}
        streamStatus={streamStatus}
        certificateFailure={certificateFailure}
        remotePageHandle={remotePageHandle}
        activeRuntimeEnvironmentId={runtimeEnvironmentId}
        worktreeId={worktreeId}
        runtimeWorktree={runtimeWorktree}
        runtimeTarget={runtimeTarget}
        isActive={isActive}
        onGoto={(url) => runRemoteNavigation('browser.goto', url)}
        onNavigateToUrl={navigateToUrl}
        onReconnect={reconnectRemoteStream}
        onBeforeProceedCertificate={abandonRemoteNavigation}
        handleRemotePointerDown={handleRemotePointerDown}
        handleRemotePointerUp={handleRemotePointerUp}
        handleRemoteContextMenu={handleRemoteContextMenu}
        handleRemoteScreenshotKeyDown={handleRemoteScreenshotKeyDown}
        handleRemoteScreenshotPaste={handleRemoteScreenshotPaste}
        handleRemotePointerMove={handleRemotePointerMove}
        annotateOverlays={annotateOverlays}
      />
    </div>
  )
}
