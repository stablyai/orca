import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  isRemoteBrowserInputOpenedDialogError,
  isRemoteBrowserPageMissingError
} from './remote-browser-stream-errors'
import { useRemoteBrowserPageKeyboard } from './use-remote-browser-page-keyboard'
import type { BrowserPageEditCommand } from '../assemble-chrome/context-menu/browser-page-context-menu-items'
import {
  RemoteBrowserInputQueue,
  type LatestRemoteBrowserInput
} from './remote-browser-input-queue'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import {
  getRemoteBrowserMouseButton,
  mapRemoteBrowserClientPoint,
  resolveRemoteBrowserCssViewport,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageInputQueue(): {
  inputQueue: RemoteBrowserInputQueue
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  clearPendingRemoteInput: () => void
  resetRemoteInputQueue: () => void
} {
  const [inputQueue] = useState(() => new RemoteBrowserInputQueue())
  const enqueueRemoteInput = useCallback(
    (operation: () => Promise<void>): Promise<void> => inputQueue.enqueue(operation),
    [inputQueue]
  )
  const clearPendingRemoteInput = useCallback((): void => inputQueue.clearLatest(), [inputQueue])
  const resetRemoteInputQueue = useCallback((): void => inputQueue.reset(), [inputQueue])
  return { inputQueue, enqueueRemoteInput, clearPendingRemoteInput, resetRemoteInputQueue }
}

export function useRemoteBrowserPageInput({
  busy,
  pickerAvailable,
  pagePointerOwned,
  inputQueue,
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
}: {
  busy: boolean
  pickerAvailable: boolean
  /** A page tool (the element picker) owns the pointer: hover and right presses go to the page. */
  pagePointerOwned: boolean
  inputQueue: RemoteBrowserInputQueue
  imageRef: React.RefObject<HTMLImageElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  remoteCssViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  frameMetadata: BrowserScreencastFrameMetadata | null
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): {
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  /** Present only while a page tool owns the pointer. */
  handleRemotePointerMove: ((event: React.PointerEvent<HTMLImageElement>) => void) | undefined
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
  handleRemoteScreenshotPaste: (event: React.ClipboardEvent<HTMLImageElement>) => void
  runRemoteEditCommand: (command: BrowserPageEditCommand) => void
} {
  const rightPressForwardedRef = useRef(false)
  const getRemoteImagePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const image = imageRef.current
      if (!image || !remoteViewportRef.current) {
        return null
      }
      return mapRemoteBrowserClientPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        frameRect: image.getBoundingClientRect(),
        cssViewport: resolveRemoteBrowserCssViewport({
          cssViewportSize: remoteCssViewportSizeRef.current,
          requestedViewportSize: remoteViewportSizeRef.current,
          frameMetadata,
          naturalSize: { width: image.naturalWidth, height: image.naturalHeight }
        })
      })
    },
    [frameMetadata, imageRef, remoteCssViewportSizeRef, remoteViewportRef, remoteViewportSizeRef]
  )

  const handleRemotePointerDown = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const image = imageRef.current
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    // Right presses open Orca's page menu unless a page tool owns the pointer.
    if (button === 'right' && !pagePointerOwned) {
      return
    }
    if (!target || !pageId || !image || !operationToken || !point || !button) {
      return
    }
    if (button === 'right') {
      rightPressForwardedRef.current = true
    }
    event.preventDefault()
    image.focus()
    // Why: a release over the letterbox gutter or outside the pane must still send mouseUp, or
    // the host page keeps the button held.
    if (typeof image.setPointerCapture === 'function') {
      try {
        image.setPointerCapture(event.pointerId)
      } catch {
        // The pointer is already gone; its release will not arrive anywhere to capture.
      }
    }
    setPaneNotice(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const params = { worktree: runtimeWorktree, page: pageId }
        await callRuntimeRpc(
          target,
          'browser.mouseMove',
          { ...params, x: point.x, y: point.y },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        await callRuntimeRpc(
          target,
          'browser.mouseDown',
          { ...params, button },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          if (isRemoteBrowserInputOpenedDialogError(error)) {
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote mouse input failed.'
          })
        }
      }
    })
  }

  const handleRemotePointerUp = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right' && !pagePointerOwned && !rightPressForwardedRef.current) {
      return
    }
    if (!target || !pageId || !operationToken || !point || !button) {
      return
    }
    if (button === 'right') {
      rightPressForwardedRef.current = false
    }
    event.preventDefault()
    setPaneNotice(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const params = { worktree: runtimeWorktree, page: pageId }
        await callRuntimeRpc(
          target,
          'browser.mouseMove',
          { ...params, x: point.x, y: point.y },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        await callRuntimeRpc(
          target,
          'browser.mouseUp',
          { ...params, button },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        scheduleRemoteTabInfoRefresh(operationToken, 250)
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          if (isRemoteBrowserInputOpenedDialogError(error)) {
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote mouse input failed.'
          })
        }
      }
    })
  }

  const { handleRemoteScreenshotKeyDown, handleRemoteScreenshotPaste, runRemoteEditCommand } =
    useRemoteBrowserPageKeyboard({
      pickerAvailable,
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

  const hoverRef = useRef<LatestRemoteBrowserInput<RemoteBrowserHoverMove> | null>(null)
  useEffect(() => {
    const hover = inputQueue.latest<RemoteBrowserHoverMove>({
      merge: (_pending, next) => next,
      send: (move) =>
        isCurrentRemoteOperationToken(move.operationToken) ? sendRemoteBrowserHover(move) : noWork
    })
    hoverRef.current = hover
    return () => {
      hover.dispose()
      hoverRef.current = null
    }
  }, [inputQueue, isCurrentRemoteOperationToken])

  const handleRemotePointerMove = (event: React.PointerEvent<HTMLImageElement>): void => {
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    if (busy || !target || !pageId || !operationToken || !point) {
      return
    }
    hoverRef.current?.push({ target, worktree: runtimeWorktree, pageId, operationToken, point })
  }

  return {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemotePointerMove: pagePointerOwned ? handleRemotePointerMove : undefined,
    handleRemoteScreenshotKeyDown,
    handleRemoteScreenshotPaste,
    runRemoteEditCommand
  }
}

type RemoteBrowserHoverMove = {
  target: RemoteBrowserRuntimeTarget
  worktree: string
  pageId: string
  operationToken: RemoteBrowserOperationToken
  point: { x: number; y: number }
}

const noWork = Promise.resolve()

// Hover is advisory: a dropped move is replaced by the next one, so failures stay silent.
function sendRemoteBrowserHover(move: RemoteBrowserHoverMove): Promise<void> {
  return callRuntimeRpc(
    move.target,
    'browser.mouseMove',
    { worktree: move.worktree, page: move.pageId, x: move.point.x, y: move.point.y },
    { timeoutMs: 15_000, suppressFeatureInteraction: true }
  ).then(
    () => {},
    () => {}
  )
}
