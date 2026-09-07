import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

import { decodeBrowserScreencastFrame } from '../../../../../shared/browser-screencast-protocol'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import type { BrowserTabInfo } from '../../../../../shared/runtime-types'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import { useRemoteBrowserStreamActivation } from './use-remote-browser-stream-activation'
import {
  decodeRemoteBrowserFrameUrl,
  getRemoteBrowserDeviceScaleFactor,
  readRemoteCssViewportSize,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget,
  type RemoteBrowserStreamBridge
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageStream({
  activeRuntimeEnvironmentId,
  browserPageId,
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
  applyTabInfo,
  clearStreamFrame,
  closeMissingRemotePage,
  clearPendingRemoteWheel,
  setPaneNotice,
  setPaneBusy,
  setFrameUrl,
  setFrameMetadata
}: {
  activeRuntimeEnvironmentId: string
  browserPageId: string
  isActive: boolean
  lifecycle: RemoteBrowserStreamLifecycle
  stagedPage: boolean
  runtimeWorktree: string
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  remoteViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteCssViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteViewportTimerRef: React.MutableRefObject<number | null>
  streamFrameUrlRef: React.MutableRefObject<string | null>
  pendingFrameDecodeRef: React.MutableRefObject<number>
  streamBridgeRef: React.MutableRefObject<RemoteBrowserStreamBridge>
  isActiveRef: React.RefObject<boolean>
  applyTabInfo: (tab: Pick<BrowserTabInfo, 'url' | 'title'>) => void
  clearStreamFrame: () => void
  closeMissingRemotePage: (remotePageId?: string | null) => void
  clearPendingRemoteWheel: () => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  setPaneBusy: (busy: boolean) => void
  setFrameUrl: (url: string | null) => void
  setFrameMetadata: (metadata: BrowserScreencastFrameMetadata | null) => void
}): {
  reconnectRemoteStream: () => void
} {
  // Bumped by Reconnect to re-run the open effect from scratch. See reconnectRemoteStream.
  const [reopenNonce, setReopenNonce] = useState(0)

  const rememberRemoteViewportSize = useCallback(
    (next: RemoteBrowserViewportSize): RemoteBrowserViewportSize => {
      const prev = remoteViewportSizeRef.current
      if (
        !prev ||
        Math.abs(prev.width - next.width) > 3 ||
        Math.abs(prev.height - next.height) > 3
      ) {
        remoteViewportSizeRef.current = next
        return next
      }
      return prev
    },
    [remoteViewportSizeRef]
  )

  const readCurrentRemoteViewportSize = useCallback((): RemoteBrowserViewportSize | null => {
    const element = remoteViewportRef.current
    if (!element) {
      return null
    }
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }
    return {
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height))
    }
  }, [remoteViewportRef])

  const readRemoteViewportSize = useCallback((): RemoteBrowserViewportSize | null => {
    const next = readCurrentRemoteViewportSize()
    return next ? rememberRemoteViewportSize(next) : remoteViewportSizeRef.current
  }, [readCurrentRemoteViewportSize, rememberRemoteViewportSize, remoteViewportSizeRef])

  const waitForRemoteViewportSize =
    useCallback(async (): Promise<RemoteBrowserViewportSize | null> => {
      for (let i = 0; i < 3; i += 1) {
        const next = readCurrentRemoteViewportSize()
        if (next) {
          return rememberRemoteViewportSize(next)
        }
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve())
        })
      }
      return readRemoteViewportSize()
    }, [readCurrentRemoteViewportSize, readRemoteViewportSize, rememberRemoteViewportSize])

  const syncRemoteViewport = useCallback(
    async (pageId: string): Promise<void> => {
      const target = runtimeTarget()
      const size = readRemoteViewportSize()
      if (!target || !size) {
        return
      }
      await callRuntimeRpc(
        target,
        'browser.viewport',
        {
          worktree: runtimeWorktree,
          page: pageId,
          width: size.width,
          height: size.height,
          deviceScaleFactor: getRemoteBrowserDeviceScaleFactor(),
          mobile: false
        },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      )
      try {
        // Why: the streamed bitmap can include the host compositor surface, but CDP input wants the guest page's CSS viewport coords.
        const viewport = await callRuntimeRpc(
          target,
          'browser.eval',
          {
            worktree: runtimeWorktree,
            page: pageId,
            expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })'
          },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        remoteCssViewportSizeRef.current = readRemoteCssViewportSize(viewport) ?? size
      } catch {
        remoteCssViewportSizeRef.current = size
      }
    },
    [readRemoteViewportSize, remoteCssViewportSizeRef, runtimeTarget, runtimeWorktree]
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    const element = remoteViewportRef.current
    if (!element) {
      return
    }
    const scheduleSync = (): void => {
      readRemoteViewportSize()
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
      }
      remoteViewportTimerRef.current = window.setTimeout(() => {
        remoteViewportTimerRef.current = null
        const pageId = lifecycle.tokens.remotePage
        if (!pageId || !isActiveRef.current) {
          return
        }
        void syncRemoteViewport(pageId)
          .then(() => lifecycle.restartForViewport(pageId))
          .catch(() => {})
      }, 150)
    }
    scheduleSync()
    const observer = new ResizeObserver(scheduleSync)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
    }
  }, [
    isActive,
    isActiveRef,
    lifecycle,
    readRemoteViewportSize,
    remoteViewportRef,
    remoteViewportTimerRef,
    syncRemoteViewport
  ])

  const updateStreamFrame = useCallback(
    (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>): void => {
      if (!lifecycle.tokens.isCurrentStreamToken(token)) {
        return
      }
      const frame = decodeBrowserScreencastFrame(bytes)
      if (!frame) {
        return
      }
      const imageBuffer = frame.image.buffer.slice(
        frame.image.byteOffset,
        frame.image.byteOffset + frame.image.byteLength
      ) as ArrayBuffer
      const nextUrl = URL.createObjectURL(
        new Blob([imageBuffer], { type: `image/${frame.format}` })
      )
      const decodeGeneration = pendingFrameDecodeRef.current + 1
      pendingFrameDecodeRef.current = decodeGeneration
      void decodeRemoteBrowserFrameUrl(nextUrl)
        .then(() => {
          if (
            pendingFrameDecodeRef.current !== decodeGeneration ||
            !lifecycle.tokens.isCurrentStreamToken(token)
          ) {
            URL.revokeObjectURL(nextUrl)
            return
          }
          const prevUrl = streamFrameUrlRef.current
          streamFrameUrlRef.current = nextUrl
          setFrameMetadata(frame.metadata)
          setFrameUrl(nextUrl)
          setPaneBusy(false)
          if (prevUrl) {
            URL.revokeObjectURL(prevUrl)
          }
        })
        .catch(() => {
          URL.revokeObjectURL(nextUrl)
        })
    },
    [
      lifecycle,
      pendingFrameDecodeRef,
      setFrameMetadata,
      setFrameUrl,
      setPaneBusy,
      streamFrameUrlRef
    ]
  )

  // Publish only callbacks from a committed render.
  useLayoutEffect(() => {
    streamBridgeRef.current = {
      applyTabInfo,
      clearFrame: clearStreamFrame,
      handleFrameBytes: updateStreamFrame,
      closeMissingRemotePage,
      waitForViewportSize: waitForRemoteViewportSize,
      syncViewport: syncRemoteViewport
    }
  }, [
    applyTabInfo,
    clearStreamFrame,
    closeMissingRemotePage,
    streamBridgeRef,
    syncRemoteViewport,
    updateStreamFrame,
    waitForRemoteViewportSize
  ])

  const reconnectRemoteStream = useCallback((): void => {
    // No status write here: bumping the nonce re-runs the open effect, and open() publishes
    // 'opening'. Setting it from two places is how the old three-variable version drifted.
    setPaneNotice(null)
    // Why re-run the whole open effect rather than resume the stream: reconnect has to work in the
    // cases where there is nothing to resume — the remote page was never created, or the very first
    // open failed. Resuming a token only covers a stream that once existed.
    setReopenNonce((nonce) => nonce + 1)
  }, [setPaneNotice])

  useRemoteBrowserStreamActivation({
    activeRuntimeEnvironmentId,
    browserPageId,
    clearPendingRemoteWheel,
    isActive,
    lifecycle,
    reopenNonce,
    runtimeWorktree,
    stagedPage
  })

  return { reconnectRemoteStream }
}
