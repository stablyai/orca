import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import { browserPageExists } from '../describe-page/browser-page-load-error'
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
  // The single source for what the stream is doing. busy, the notice, and whether the reconnect
  // control renders are all derived below, so they cannot disagree — see
  // remote-browser-stream-status.ts for the four ways they used to.
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
  const currentBrowserTabIdRef = useRef(browserTab.id)
  const currentBrowserTabUrlRef = useRef(browserTab.url)
  const runtimeWorktree = useMemo(() => toRuntimeWorktreeSelector(worktreeId), [worktreeId])
  const runtimeWorktreeRef = useRef(runtimeWorktree)
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(activeRuntimeEnvironmentId)
  // Why: the stream lifecycle is built once per pane, before the callbacks it needs exist. It
  // reaches them through this bridge so it never captures a render's stale closure.
  const streamBridgeRef = useRef<RemoteBrowserStreamBridge>(NO_REMOTE_BROWSER_STREAM_BRIDGE)
  const lifecycleRef = useRef<RemoteBrowserStreamLifecycle | null>(null)
  const closeBrowserPage = useAppStore((s) => s.closeBrowserPage)
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)

  useLayoutEffect(() => {
    currentBrowserTabIdRef.current = browserTab.id
    currentBrowserTabUrlRef.current = browserTab.url
    activeRuntimeEnvironmentIdRef.current = activeRuntimeEnvironmentId
    isActiveRef.current = isActive
    runtimeWorktreeRef.current = runtimeWorktree
  }, [activeRuntimeEnvironmentId, browserTab.id, browserTab.url, isActive, runtimeWorktree])

  if (!lifecycleRef.current) {
    lifecycleRef.current = new RemoteBrowserStreamLifecycle({
      identity: {
        isMounted: () => mountedRef.current,
        isActive: () => isActiveRef.current,
        getTabId: () => currentBrowserTabIdRef.current,
        getEnvironmentId: () => activeRuntimeEnvironmentIdRef.current,
        browserPageExists
      },
      callRpc: callRuntimeRpc,
      subscribeScreencast: (args, callbacks) =>
        window.api.runtimeEnvironments.subscribe(args, callbacks),
      getWorktreeSelector: () => runtimeWorktreeRef.current,
      getCurrentUrl: () => currentBrowserTabUrlRef.current,
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
        // Why every status change clears the pane's notice, not just the recovering ones: a pane
        // notice describes the situation the PREVIOUS status described, so any transition makes it
        // stale. Clearing only on live/opening left a 'direct' notice — which outranks the stream's
        // own — on screen after the stream stopped, so a stranded pane showed "Enter a valid http(s)
        // or localhost URL." beside its Reconnect button and never showed the actual cause.
        // It also has no other owner: nothing else would dismiss it.
        setPaneNotice(null)
      },
      applyTabInfo: (tab) => streamBridgeRef.current.applyTabInfo(tab),
      clearFrame: () => streamBridgeRef.current.clearFrame(),
      handleFrameBytes: (token, bytes) => streamBridgeRef.current.handleFrameBytes(token, bytes),
      closeMissingRemotePage: (remotePageId) =>
        streamBridgeRef.current.closeMissingRemotePage(remotePageId),
      waitForViewportSize: () => streamBridgeRef.current.waitForViewportSize(),
      readViewportSize: () => remoteViewportSizeRef.current,
      syncViewport: (pageId) => streamBridgeRef.current.syncViewport(pageId)
    })
  }
  const lifecycle = lifecycleRef.current

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

  useEffect(() => {
    if (!activeRuntimeEnvironmentId) {
      return
    }
    return () => {
      const remotePageId = lifecycle.tokens.remotePage
      if (!remotePageId) {
        return
      }
      const state = useAppStore.getState()
      const currentEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      const pageStillExists = browserPageExists(browserTab.id)
      if (currentEnvironmentId === activeRuntimeEnvironmentId && pageStillExists) {
        return
      }
      const removedHandle = state.removeRemoteBrowserPageHandle(browserTab.id, remotePageId)
      lifecycle.tokens.setRemotePage(null)
      if (!removedHandle) {
        return
      }
      // Why: remote tabs outlive React components on the daemon; close only when the local page or its runtime environment is gone.
      void callRuntimeRpc(
        { kind: 'environment', environmentId: removedHandle.environmentId },
        'browser.tabClose',
        { worktree: runtimeWorktree, page: removedHandle.remotePageId },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      ).catch(() => {})
    }
  }, [activeRuntimeEnvironmentId, browserTab.id, lifecycle, runtimeWorktree, worktreeId])

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
