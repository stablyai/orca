import { useCallback, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  isRemoteBrowserInputOpenedDialogError,
  isRemoteBrowserPageMissingError
} from './remote-browser-stream-errors'
import { useRemoteBrowserPageKeyboard } from './use-remote-browser-page-keyboard'
import type { BrowserPageEditCommand } from '../assemble-chrome/context-menu/browser-page-context-menu-items'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'
import { useRemoteBrowserPageHover } from './use-remote-browser-page-hover'
import { useRemoteBrowserSelectPopup } from './remote-browser-select-popup'
import type { RemoteBrowserPageInputParams } from './remote-browser-page-input-params'
import {
  getRemoteBrowserMouseButton,
  mapRemoteBrowserClientPoint,
  readRemoteBrowserFrameGeometry
} from './remote-browser-page-input-model'
import {
  isMacControlClick,
  readRemoteBrowserMouseModifiers
} from './remote-browser-mouse-modifiers'

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

export function useRemoteBrowserPageInput(input: RemoteBrowserPageInputParams): {
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerMove: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
  handleRemoteScreenshotPaste: (event: React.ClipboardEvent<HTMLImageElement>) => void
  runRemoteEditCommand: (command: BrowserPageEditCommand) => void
  selectPopupElement: React.JSX.Element | null
} {
  const {
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
  } = input
  const { readSelectPopupAfterPress, selectPopupElement } = useRemoteBrowserSelectPopup(input)
  const rightPressForwardedRef = useRef(false)
  // macOS Control+click is a right press, through to its release.
  const controlClickRef = useRef(false)
  const getRemoteImagePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const image = imageRef.current
      if (!image || !remoteViewportRef.current) {
        return null
      }
      return mapRemoteBrowserClientPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        ...readRemoteBrowserFrameGeometry(image, {
          cssViewportSize: remoteCssViewportSizeRef.current,
          requestedViewportSize: remoteViewportSizeRef.current,
          frameMetadata
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
    controlClickRef.current = isMacControlClick(event)
    const button = controlClickRef.current ? 'right' : getRemoteBrowserMouseButton(event.button)
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
    const modifiers = readRemoteBrowserMouseModifiers(event, target)
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
          { ...params, button, modifiers },
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
    const controlClick = controlClickRef.current && event.button === 0
    controlClickRef.current = false
    const button = controlClick ? 'right' : getRemoteBrowserMouseButton(event.button)
    if (button === 'right' && !pagePointerOwned && !rightPressForwardedRef.current) {
      return
    }
    if (!target || !pageId || !operationToken || !point || !button) {
      return
    }
    if (button === 'right') {
      rightPressForwardedRef.current = false
    }
    const modifiers = readRemoteBrowserMouseModifiers(event, target)
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
          { ...params, button, modifiers },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        scheduleRemoteTabInfoRefresh(operationToken, 250)
        await readSelectPopupAfterPress({ target, pageId, operationToken, button })
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

  const handleRemotePointerMove = useRemoteBrowserPageHover({
    busy,
    inputQueue,
    runtimeTarget,
    lifecycle,
    runtimeWorktree,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    getRemoteImagePoint
  })

  return {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemotePointerMove,
    handleRemoteScreenshotKeyDown,
    handleRemoteScreenshotPaste,
    runRemoteEditCommand,
    selectPopupElement
  }
}
