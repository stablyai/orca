import {
  noteSleptRemotePageAnswered,
  sleptRemotePageMissingAction,
  useReopenSleptRemotePage
} from './use-slept-remote-page'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  REMOTE_BROWSER_STREAM_IDLE,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'
import {
  getRemoteBrowserDeviceScaleFactor,
  NO_REMOTE_BROWSER_STREAM_BRIDGE,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserStreamBridge
} from './remote-browser-page-input-model'
import { subscribeRuntimeEnvironment } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import {
  readRemoteBrowserPage,
  readRemoteBrowserPageObservation
} from './remote-browser-page-observation'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { javaScriptDialogPrompt } from '../browser-javascript-dialog-prompt'
import { useCloseOrphanedRemotePageOnTeardown } from './use-close-orphaned-remote-page'

export function useRemoteBrowserPageLifecycle({
  browserTab,
  worktreeId,
  activeRuntimeEnvironmentId,
  isActive,
  setPaneNotice,
  setPaneBusy,
  clearPendingRemoteWheel,
  resetRemoteInputQueue
}: {
  browserTab: BrowserPageState
  worktreeId: string
  activeRuntimeEnvironmentId: string
  isActive: boolean
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  setPaneBusy: (busy: boolean) => void
  clearPendingRemoteWheel: () => void
  resetRemoteInputQueue: () => void
}) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameMetadata, setFrameMetadata] = useState<BrowserScreencastFrameMetadata | null>(null)
  const setFrameUrlRef = useRef(setFrameUrl)
  const setFrameMetadataRef = useRef(setFrameMetadata)
  // Derive busy, notice and reconnect from one status so they cannot disagree.
  const [streamStatus, setStreamStatus] = useState<RemoteBrowserStreamStatus>(
    REMOTE_BROWSER_STREAM_IDLE
  )
  const remoteViewportSizeRef = useRef<RemoteBrowserViewportSize | null>(null)
  const remoteCssViewportSizeRef = useRef<RemoteBrowserViewportSize | null>(null)
  const remoteViewportTimerRef = useRef<number | null>(null)
  const streamFrameUrlRef = useRef<string | null>(null)
  const pendingFrameDecodeRef = useRef(0)
  const mountedRef = useRef(true)
  const isActiveRef = useRef(isActive)
  const currentWorkspaceIdRef = useRef(browserTab.workspaceId)
  const currentBrowserTabIdRef = useRef(browserTab.id)
  const currentWorktreeIdRef = useRef(browserTab.worktreeId)
  const currentBrowserTabUrlRef = useRef(browserTab.url)
  const runtimeWorktree = useMemo(() => toRuntimeWorktreeSelector(worktreeId), [worktreeId])
  const runtimeWorktreeRef = useRef(runtimeWorktree)
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(activeRuntimeEnvironmentId)
  // The lifecycle is built once; bridge committed callbacks to avoid stale render closures.
  const streamBridgeRef = useRef<RemoteBrowserStreamBridge>(NO_REMOTE_BROWSER_STREAM_BRIDGE)
  const lifecycleRef = useRef<RemoteBrowserStreamLifecycle | null>(null)
  const closeBrowserPage = useAppStore((s) => s.closeBrowserPage)
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)
  // Stable for the provider's life, so the once-built lifecycle may hold it.
  const confirm = useConfirmationDialog()

  useLayoutEffect(() => {
    currentWorkspaceIdRef.current = browserTab.workspaceId
    currentBrowserTabIdRef.current = browserTab.id
    currentWorktreeIdRef.current = browserTab.worktreeId
    currentBrowserTabUrlRef.current = browserTab.url
    activeRuntimeEnvironmentIdRef.current = activeRuntimeEnvironmentId
    isActiveRef.current = isActive
    runtimeWorktreeRef.current = runtimeWorktree
  }, [
    activeRuntimeEnvironmentId,
    browserTab.id,
    browserTab.url,
    browserTab.workspaceId,
    browserTab.worktreeId,
    isActive,
    runtimeWorktree
  ])

  if (!lifecycleRef.current) {
    lifecycleRef.current = new RemoteBrowserStreamLifecycle({
      identity: {
        isMounted: () => mountedRef.current,
        isActive: () => isActiveRef.current,
        getTabId: () => currentBrowserTabIdRef.current,
        getEnvironmentId: () => activeRuntimeEnvironmentIdRef.current,
        browserPageExists: (pageId) =>
          Boolean(
            readRemoteBrowserPage(useAppStore.getState(), currentWorkspaceIdRef.current, pageId)
          )
      },
      callRpc: callRuntimeRpc,
      subscribeScreencast: (args, callbacks) => subscribeRuntimeEnvironment(args, callbacks),
      getWorktreeSelector: () => runtimeWorktreeRef.current,
      getCurrentUrl: () => currentBrowserTabUrlRef.current,
      readCurrentObservation: () =>
        readRemoteBrowserPageObservation(
          useAppStore.getState(),
          currentWorkspaceIdRef.current,
          currentBrowserTabIdRef.current
        ),
      readStoredHandle: () =>
        useAppStore.getState().remoteBrowserPageHandlesByPageId[currentBrowserTabIdRef.current] ??
        null,
      writeStoredHandle: (handle) =>
        useAppStore.getState().setRemoteBrowserPageHandle(currentBrowserTabIdRef.current, handle),
      removeStoredHandle: (remotePageId) => {
        useAppStore
          .getState()
          .removeRemoteBrowserPageHandle(currentBrowserTabIdRef.current, remotePageId)
      },
      getDeviceScaleFactor: getRemoteBrowserDeviceScaleFactor,
      setStatus: (status) => {
        setStreamStatus(status)
        // Every transition invalidates the pane notice; stale direct feedback would outrank the stream’s failure beside Reconnect.
        setPaneNotice(null)
      },
      applyTabInfo: (tab) => {
        noteSleptRemotePageAnswered({
          id: currentBrowserTabIdRef.current,
          workspaceId: currentWorkspaceIdRef.current,
          worktreeId: currentWorktreeIdRef.current
        })
        streamBridgeRef.current.applyTabInfo(tab)
      },
      clearFrame: () => streamBridgeRef.current.clearFrame(),
      handleFrameBytes: (token, bytes) => streamBridgeRef.current.handleFrameBytes(token, bytes),
      closeMissingRemotePage: (remotePageId) =>
        streamBridgeRef.current.closeMissingRemotePage(remotePageId),
      waitForViewportSize: () => streamBridgeRef.current.waitForViewportSize(),
      readViewportSize: () => remoteViewportSizeRef.current,
      syncViewport: (pageId) => streamBridgeRef.current.syncViewport(pageId),
      askJavaScriptDialog: (dialog, signal) => javaScriptDialogPrompt.ask(confirm, dialog, signal)
    })
  }
  const lifecycle = lifecycleRef.current

  const isMounted = useCallback(() => mountedRef.current, [])
  useReopenSleptRemotePage(
    { id: browserTab.id, worktreeId: browserTab.worktreeId },
    lifecycle,
    isMounted
  )

  const runtimeTarget = useCallback(() => {
    return activeRuntimeEnvironmentId
      ? ({
          kind: 'environment',
          environmentId: activeRuntimeEnvironmentId
        } satisfies RuntimeClientTarget)
      : null
  }, [activeRuntimeEnvironmentId])

  const clearStreamFrame = useCallback((): void => {
    pendingFrameDecodeRef.current += 1
    const prevUrl = streamFrameUrlRef.current
    streamFrameUrlRef.current = null
    remoteCssViewportSizeRef.current = null
    lifecycle.forgetStreamViewportSize()
    setFrameMetadataRef.current(null)
    setFrameUrlRef.current(null)
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl)
    }
  }, [lifecycle])

  const closeMissingRemotePage = useCallback(
    (remotePageId: string | null = lifecycle.tokens.remotePage): void => {
      const state = useAppStore.getState()
      if (remotePageId) {
        state.removeRemoteBrowserPageHandle(browserTab.id, remotePageId)
      }
      lifecycle.abandonRemotePage()
      // Slept with its VM (NEW-01, LC2-P1): wait, or reopen at its URL, instead of closing.
      const action = sleptRemotePageMissingAction({
        id: browserTab.id,
        worktreeId: browserTab.worktreeId
      })
      if (action !== 'close') {
        clearStreamFrame()
        if (action === 'reopen') {
          lifecycle.open()
        }
        return
      }
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
      resetRemoteInputQueue()
      clearStreamFrame()
      setPaneNotice(null)
      setPaneBusy(false)
      // Why: a runtime-side tab close mirrors closing the visible tab; don't leave a dead pane behind.
      const workspacePageCount = state.browserPagesByWorkspace[browserTab.workspaceId]?.length ?? 0
      if (workspacePageCount <= 1) {
        closeBrowserTab(browserTab.workspaceId)
        return
      }
      closeBrowserPage(browserTab.id)
    },
    [
      browserTab.id,
      browserTab.workspaceId,
      browserTab.worktreeId,
      clearStreamFrame,
      closeBrowserPage,
      closeBrowserTab,
      lifecycle,
      resetRemoteInputQueue,
      setPaneBusy,
      setPaneNotice
    ]
  )

  const createRemoteOperationToken = useCallback(
    (remotePageId: string | null = null): RemoteBrowserOperationToken | null =>
      lifecycle.tokens.createOperationToken(remotePageId),
    [lifecycle]
  )

  const isCurrentRemoteOperationToken = useCallback(
    (token: RemoteBrowserOperationToken): boolean => lifecycle.tokens.isCurrent(token),
    [lifecycle]
  )

  useEffect(() => {
    // Why: StrictMode's mount→cleanup→mount leaves mountedRef false; re-arm or operation tokens read stale and the pane wedges.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingFrameDecodeRef.current += 1
      lifecycle.dispose()
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
      clearPendingRemoteWheel()
      if (streamFrameUrlRef.current) {
        URL.revokeObjectURL(streamFrameUrlRef.current)
        streamFrameUrlRef.current = null
      }
    }
  }, [clearPendingRemoteWheel, lifecycle])

  useEffect(() => {
    // Why: only reset frame/wheel on identity change; bumping the stream/operation generations here races the streaming effect and wedges the pane.
    lifecycle.forgetStreamViewportSize()
    clearPendingRemoteWheel()
    clearStreamFrame()
  }, [
    activeRuntimeEnvironmentId,
    browserTab.id,
    clearPendingRemoteWheel,
    clearStreamFrame,
    lifecycle
  ])

  useCloseOrphanedRemotePageOnTeardown({
    activeRuntimeEnvironmentId,
    browserTabId: browserTab.id,
    workspaceId: browserTab.workspaceId,
    lifecycle,
    runtimeWorktree,
    worktreeId
  })

  return {
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
  }
}
