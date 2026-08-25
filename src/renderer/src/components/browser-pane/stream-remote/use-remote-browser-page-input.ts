import { useCallback, useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isEditableKeyboardTarget } from '../host-guest/browser-keyboard'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey
} from './remote-browser-keyboard'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import { useRemoteBrowserPagePress } from './use-remote-browser-page-press'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import {
  getPositiveFiniteNumber,
  type PendingRemoteBrowserPress,
  type PendingRemoteBrowserWheel,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageInputQueue(): {
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  clearPendingRemoteWheel: () => void
  clearPendingRemotePress: () => void
  resetRemoteInputQueue: () => void
  pendingRemoteWheelRef: React.MutableRefObject<PendingRemoteBrowserWheel | null>
  pendingPressRef: React.MutableRefObject<PendingRemoteBrowserPress | null>
  remoteWheelFrameRef: React.MutableRefObject<number | null>
  remoteWheelInFlightRef: React.MutableRefObject<boolean>
} {
  const remoteInputQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRemoteWheelRef = useRef<PendingRemoteBrowserWheel | null>(null)
  const pendingPressRef = useRef<PendingRemoteBrowserPress | null>(null)
  const remoteWheelFrameRef = useRef<number | null>(null)
  const remoteWheelInFlightRef = useRef(false)

  const enqueueRemoteInput = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = remoteInputQueueRef.current.catch(() => {}).then(operation)
    remoteInputQueueRef.current = next.catch(() => {})
    return next
  }, [])

  const resetRemoteInputQueue = useCallback((): void => {
    remoteInputQueueRef.current = Promise.resolve()
  }, [])

  const clearPendingRemoteWheel = useCallback((): void => {
    pendingRemoteWheelRef.current = null
    remoteWheelInFlightRef.current = false
    if (remoteWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(remoteWheelFrameRef.current)
      remoteWheelFrameRef.current = null
    }
  }, [])

  // The press owns how it ends (a hold that already put the remote button down must lift it), so
  // this only asks it to; the pane's identity-change reset reaches it through here.
  const clearPendingRemotePress = useCallback((): void => {
    pendingPressRef.current?.abandon()
  }, [])

  return {
    enqueueRemoteInput,
    clearPendingRemoteWheel,
    clearPendingRemotePress,
    resetRemoteInputQueue,
    pendingRemoteWheelRef,
    pendingPressRef,
    remoteWheelFrameRef,
    remoteWheelInFlightRef
  }
}

export function useRemoteBrowserPageInput({
  busy,
  imageRef,
  remoteViewportRef,
  remoteCssViewportSizeRef,
  remoteViewportSizeRef,
  frameMetadata,
  frameUrl,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  setPaneNotice,
  pendingPressRef
}: {
  busy: boolean
  imageRef: React.RefObject<HTMLImageElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  remoteCssViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  frameMetadata: BrowserScreencastFrameMetadata | null
  frameUrl: string | null
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  pendingPressRef: React.MutableRefObject<PendingRemoteBrowserPress | null>
}): {
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerCancel: () => void
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
} {
  const getRemoteImagePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const image = imageRef.current
      const viewport = remoteViewportRef.current
      if (!image || !viewport) {
        return null
      }
      const rect = viewport.getBoundingClientRect()
      const viewportWidth =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(frameMetadata?.deviceWidth) ??
        image.naturalWidth
      const viewportHeight =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(frameMetadata?.deviceHeight) ??
        image.naturalHeight
      if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
        return null
      }
      return {
        x: Math.round(((event.clientX - rect.left) / rect.width) * viewportWidth),
        y: Math.round(((event.clientY - rect.top) / rect.height) * viewportHeight)
      }
    },
    [frameMetadata, imageRef, remoteCssViewportSizeRef, remoteViewportRef, remoteViewportSizeRef]
  )

  // Why the press is held until release: a plain click then costs one atomic browser.mouseClick
  // instead of four serialized round trips, and only the release proves it was not a drag — while a
  // press held past the threshold puts the button down without waiting for one.
  const { handleRemotePointerDown, handleRemotePointerUp, handleRemotePointerCancel } =
    useRemoteBrowserPagePress({
      busy,
      imageRef,
      frameUrl,
      getRemoteImagePoint,
      runtimeTarget,
      lifecycle,
      runtimeWorktree,
      enqueueRemoteInput,
      createRemoteOperationToken,
      isCurrentRemoteOperationToken,
      closeMissingRemotePage,
      scheduleRemoteTabInfoRefresh,
      setPaneNotice,
      pendingPressRef
    })

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    if (isEditableKeyboardTarget(event.target)) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !operationToken) {
      return
    }
    const params = { worktree: runtimeWorktree, page: pageId }
    const key = getRemoteBrowserKeyboardShortcut(event) ?? getRemoteBrowserKeypressKey(event)
    if (!key) {
      return
    }
    event.preventDefault()
    setPaneNotice(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        await callRuntimeRpc(
          target,
          'browser.keypress',
          { ...params, key },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        if (
          key === 'Enter' ||
          key === 'Meta+r' ||
          key === 'Meta+Shift+r' ||
          key === 'Control+r' ||
          key === 'Control+Shift+r'
        ) {
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        }
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote keyboard input failed.'
          })
        }
      }
    })
  }

  return {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemotePointerCancel,
    handleRemoteScreenshotKeyDown
  }
}
