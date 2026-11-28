import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type {
  LatestRemoteBrowserInput,
  RemoteBrowserInputQueue
} from './remote-browser-input-queue'
import {
  WHEEL_DELTA_LINE,
  WHEEL_DELTA_PAGE,
  type PendingRemoteBrowserWheel,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import { remoteBrowserWheelZoomDirection } from './use-remote-browser-page-zoom'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser/site-settings/browser-page-zoom'

export function useRemoteBrowserPageWheel({
  busy,
  imageRef,
  remoteViewportRef,
  frameUrl,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  getRemoteImagePoint,
  inputQueue,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  setPaneNotice,
  requestZoom
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
  inputQueue: RemoteBrowserInputQueue
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  /** Null when the host can't zoom, so zoom gestures scroll as they always did there. */
  requestZoom: ((direction: BrowserPageZoomDirection, gesture?: 'key' | 'wheel') => void) | null
}): void {
  const sendWheel = async (wheel: PendingRemoteBrowserWheel): Promise<void> => {
    const { target, pageId, operationToken, point, dx, dy } = wheel
    if (!isCurrentRemoteOperationToken(operationToken)) {
      return
    }
    const params = { worktree: runtimeWorktree, page: pageId }
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
        { ...params, dx, dy },
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
  }
  const sendWheelRef = useRef(sendWheel)
  useLayoutEffect(() => {
    sendWheelRef.current = sendWheel
  })
  const wheelRef = useRef<LatestRemoteBrowserInput<PendingRemoteBrowserWheel> | null>(null)
  useEffect(() => {
    // Deltas aimed at the same page add up; a new page or stream generation starts over.
    const wheel = inputQueue.latest<PendingRemoteBrowserWheel>({
      perFrame: true,
      merge: (pending, next) =>
        pending?.target.environmentId === next.target.environmentId &&
        pending.pageId === next.pageId &&
        pending.operationToken.generation === next.operationToken.generation
          ? { ...next, dx: pending.dx + next.dx, dy: pending.dy + next.dy }
          : next,
      send: (value) => sendWheelRef.current(value)
    })
    wheelRef.current = wheel
    return () => {
      wheel.dispose()
      wheelRef.current = null
    }
  }, [inputQueue])

  const handleRemoteScreenshotWheel = useCallback(
    (event: WheelEvent): void => {
      const zoomDirection = requestZoom ? remoteBrowserWheelZoomDirection(event) : null
      if (requestZoom && zoomDirection) {
        event.preventDefault()
        requestZoom(zoomDirection, 'wheel')
        return
      }
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
      wheelRef.current?.push({ target, pageId, operationToken, point, dx, dy })
    },
    [
      busy,
      createRemoteOperationToken,
      getRemoteImagePoint,
      lifecycle,
      remoteViewportRef,
      requestZoom,
      runtimeTarget,
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
