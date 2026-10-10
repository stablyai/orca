import { useCallback, useEffect } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import {
  WHEEL_DELTA_LINE,
  WHEEL_DELTA_PAGE,
  type PendingRemoteBrowserWheel,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageWheel({
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
}: {
  busy: boolean
  imageRef: React.RefObject<HTMLImageElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  frameUrl: string | null
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  pendingRemoteWheelRef: React.MutableRefObject<PendingRemoteBrowserWheel | null>
  remoteWheelFrameRef: React.MutableRefObject<number | null>
  remoteWheelInFlightRef: React.MutableRefObject<boolean>
}): void {
  const schedulePendingRemoteWheel = useCallback((): void => {
    if (remoteWheelFrameRef.current !== null || remoteWheelInFlightRef.current) {
      return
    }
    remoteWheelFrameRef.current = window.requestAnimationFrame(() => {
      remoteWheelFrameRef.current = null
      const pending = pendingRemoteWheelRef.current
      if (!pending || remoteWheelInFlightRef.current) {
        return
      }
      pendingRemoteWheelRef.current = null
      remoteWheelInFlightRef.current = true
      const { target, pageId, operationToken, point, dx, dy } = pending
      const params = { worktree: runtimeWorktree, page: pageId }
      void enqueueRemoteInput(async () => {
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        try {
          await callRuntimeRpc(
            target,
            'browser.mouseMove',
            { ...params, x: point.x, y: point.y },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          )
          await callRuntimeRpc(
            target,
            'browser.mouseWheel',
            {
              ...params,
              dx,
              dy
            },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          )
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        } catch (error) {
          if (isCurrentRemoteOperationToken(operationToken)) {
            if (isRemoteBrowserPageMissingError(error)) {
              closeMissingRemotePage(pageId)
              return
            }
            setPaneNotice({
              kind: 'consequence',
              text: error instanceof Error ? error.message : 'Remote scroll failed.'
            })
          }
        }
      }).finally(() => {
        remoteWheelInFlightRef.current = false
        if (pendingRemoteWheelRef.current) {
          schedulePendingRemoteWheel()
        }
      })
    })
  }, [
    closeMissingRemotePage,
    enqueueRemoteInput,
    isCurrentRemoteOperationToken,
    pendingRemoteWheelRef,
    remoteWheelFrameRef,
    remoteWheelInFlightRef,
    scheduleRemoteTabInfoRefresh,
    setPaneNotice,
    runtimeWorktree
  ])

  const handleRemoteScreenshotWheel = useCallback(
    (event: WheelEvent): void => {
      if (busy) {
        event.preventDefault()
        return
      }
      const target = runtimeTarget()
      const pageId = lifecycle.tokens.remotePage
      const operationToken = pageId ? createRemoteOperationToken(pageId) : null
      const point = getRemoteImagePoint(event)
      if (!target || !pageId || !operationToken || !point) {
        return
      }
      event.preventDefault()
      setPaneNotice(null)
      const deltaMultiplier =
        event.deltaMode === WHEEL_DELTA_LINE
          ? 16
          : event.deltaMode === WHEEL_DELTA_PAGE
            ? (remoteViewportRef.current?.clientHeight ?? 800)
            : 1
      const dx = Math.round(event.deltaX * deltaMultiplier)
      const dy = Math.round(event.deltaY * deltaMultiplier)
      if (dx === 0 && dy === 0) {
        return
      }
      const current = pendingRemoteWheelRef.current
      const sameTarget =
        current?.target.environmentId === target.environmentId &&
        current.pageId === pageId &&
        current.operationToken.generation === operationToken.generation
      pendingRemoteWheelRef.current = sameTarget
        ? {
            ...current,
            point,
            dx: current.dx + dx,
            dy: current.dy + dy
          }
        : {
            target,
            pageId,
            operationToken,
            point,
            dx,
            dy
          }
      schedulePendingRemoteWheel()
    },
    [
      busy,
      createRemoteOperationToken,
      getRemoteImagePoint,
      lifecycle,
      pendingRemoteWheelRef,
      remoteViewportRef,
      runtimeTarget,
      schedulePendingRemoteWheel,
      setPaneNotice
    ]
  )

  useEffect(() => {
    const image = imageRef.current
    if (!image || !frameUrl) {
      return
    }
    // Why: React binds wheel listeners passively in Chromium, so bind natively non-passive to preventDefault scroll.
    image.addEventListener('wheel', handleRemoteScreenshotWheel, { passive: false })
    return () => image.removeEventListener('wheel', handleRemoteScreenshotWheel)
  }, [frameUrl, handleRemoteScreenshotWheel, imageRef])
}
