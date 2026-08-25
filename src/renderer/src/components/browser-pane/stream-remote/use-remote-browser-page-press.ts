import { useCallback, useEffect, useRef } from 'react'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import {
  sendRemoteBrowserClick,
  sendRemoteBrowserHeldRelease,
  sendRemoteBrowserPressHold
} from './remote-browser-click-dispatch'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import {
  getRemoteBrowserMouseButton,
  hasRemoteBrowserClickModifier,
  isSimpleRemoteBrowserClick,
  REMOTE_BROWSER_PRESS_HOLD_MS,
  REMOTE_BROWSER_PRESS_MAX_AGE_MS,
  type PendingRemoteBrowserPress,
  type RemoteBrowserImagePoint,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserPressState,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

// Owns one press at a time: a quick press becomes an atomic click on release, a held press puts the
// button down while the user is still holding, and every way a press can end without a usable
// release drops it — releasing the remote button first if the hold already put one down.
export function useRemoteBrowserPagePress({
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
}: {
  busy: boolean
  imageRef: React.RefObject<HTMLImageElement | null>
  frameUrl: string | null
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => RemoteBrowserImagePoint | null
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
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerCancel: () => void
} {
  // Hosts predating browser.mouseClick answer method_not_found; remember per environment so the
  // legacy chain is not re-probed on every click.
  const mouseClickUnsupportedEnvironmentRef = useRef<string | null>(null)

  const reportRemoteInputFailure = useCallback(
    (token: RemoteBrowserOperationToken, pageId: string, error: unknown): void => {
      if (!isCurrentRemoteOperationToken(token)) {
        return
      }
      if (isRemoteBrowserPageMissingError(error)) {
        closeMissingRemotePage(pageId)
        return
      }
      setPaneNotice({
        kind: 'consequence',
        text: error instanceof Error ? error.message : 'Remote mouse input failed.'
      })
    },
    [closeMissingRemotePage, isCurrentRemoteOperationToken, setPaneNotice]
  )

  const takePendingPress = useCallback(
    (pending: PendingRemoteBrowserPress): void => {
      if (pendingPressRef.current === pending) {
        pendingPressRef.current = null
      }
      if (pending.holdTimer !== null) {
        window.clearTimeout(pending.holdTimer)
        pending.holdTimer = null
      }
    },
    [pendingPressRef]
  )

  const releaseHeldPress = useCallback(
    (pending: PendingRemoteBrowserPress, release: RemoteBrowserPressState): void => {
      // Why no operation-token guard here: the remote button is already down, and a guard that
      // drops this release strands it for the life of the page.
      void enqueueRemoteInput(async () => {
        try {
          await sendRemoteBrowserHeldRelease({
            target: pending.target,
            params: { worktree: runtimeWorktree, page: pending.press.pageId },
            press: pending.press,
            release
          })
        } catch (error) {
          reportRemoteInputFailure(pending.operationToken, pending.press.pageId, error)
        }
      })
    },
    [enqueueRemoteInput, reportRemoteInputFailure, runtimeWorktree]
  )

  const dispatchPressHold = useCallback(
    (pending: PendingRemoteBrowserPress): void => {
      if (pendingPressRef.current !== pending || pending.holdDispatched) {
        return
      }
      // The hold outlived the identity it was pressed against; a button down on another page is
      // worse than a hold that never arrives.
      if (
        lifecycle.tokens.remotePage !== pending.press.pageId ||
        runtimeTarget()?.environmentId !== pending.press.environmentId
      ) {
        takePendingPress(pending)
        return
      }
      // Marked before the queued call runs so a release enqueued behind it always lifts this button.
      pending.holdDispatched = true
      void enqueueRemoteInput(async () => {
        if (!isCurrentRemoteOperationToken(pending.operationToken)) {
          return
        }
        try {
          await sendRemoteBrowserPressHold({
            target: pending.target,
            params: { worktree: runtimeWorktree, page: pending.press.pageId },
            press: pending.press
          })
        } catch (error) {
          reportRemoteInputFailure(pending.operationToken, pending.press.pageId, error)
        }
      })
    },
    [
      enqueueRemoteInput,
      isCurrentRemoteOperationToken,
      lifecycle,
      pendingPressRef,
      reportRemoteInputFailure,
      runtimeTarget,
      runtimeWorktree,
      takePendingPress
    ]
  )

  const handleRemotePointerDown = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const image = imageRef.current
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right') {
      return
    }
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !image || !point || !button || !operationToken) {
      return
    }
    // A press still pending here never got its release, so it can only be stale.
    pendingPressRef.current?.abandon()
    event.preventDefault()
    image.focus()
    setPaneNotice(null)
    const pending: PendingRemoteBrowserPress = {
      press: {
        environmentId: target.environmentId,
        pageId,
        button,
        point,
        modified: hasRemoteBrowserClickModifier(event)
      },
      target,
      operationToken,
      pointerId: event.pointerId,
      pressedAt: Date.now(),
      holdTimer: null,
      holdDispatched: false,
      abandon: () => {
        takePendingPress(pending)
        if (pending.holdDispatched) {
          releaseHeldPress(pending, pending.press)
        }
      }
    }
    // Why capture: without it a release outside the <img> never arrives, so the press would sit
    // here until some unrelated later pointerup replayed it as a press the user never made.
    try {
      image.setPointerCapture(event.pointerId)
    } catch {
      // Detached image or a runtime without capture: the leave/blur handlers bound below are the
      // fallback that bounds the press instead.
    }
    pendingPressRef.current = pending
    pending.holdTimer = window.setTimeout(() => {
      pending.holdTimer = null
      dispatchPressHold(pending)
    }, REMOTE_BROWSER_PRESS_HOLD_MS)
  }

  const handleRemotePointerCancel = (): void => {
    pendingPressRef.current?.abandon()
  }

  const handleRemotePointerUp = (event: React.PointerEvent<HTMLImageElement>): void => {
    const pending = pendingPressRef.current
    if (!pending) {
      return
    }
    // A second pointer (touch/pen) must not consume this press. Mice share one pointerId, so the
    // stray-pointerup case is bounded by capture, the leave/blur handlers, and the age cap.
    if (pending.pointerId !== event.pointerId) {
      return
    }
    takePendingPress(pending)
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    // Why drop instead of replay: an incoherent pair (page swapped, or a second button pressed
    // before this release) would put a button down that nothing releases. A hold already put one
    // down, so that one is still lifted, at the point it was pressed.
    if (
      busy ||
      !target ||
      !pageId ||
      !point ||
      !button ||
      button === 'right' ||
      target.environmentId !== pending.press.environmentId ||
      pageId !== pending.press.pageId ||
      button !== pending.press.button
    ) {
      if (pending.holdDispatched) {
        releaseHeldPress(pending, pending.press)
      }
      return
    }
    const release: RemoteBrowserPressState = {
      environmentId: target.environmentId,
      pageId,
      button,
      point,
      modified: hasRemoteBrowserClickModifier(event)
    }
    event.preventDefault()
    setPaneNotice(null)
    if (pending.holdDispatched) {
      releaseHeldPress(pending, release)
      return
    }
    const operationToken = createRemoteOperationToken(pageId)
    if (!operationToken || Date.now() - pending.pressedAt > REMOTE_BROWSER_PRESS_MAX_AGE_MS) {
      return
    }
    const press = pending.press
    const atomic = isSimpleRemoteBrowserClick(press, release)
    void enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        await sendRemoteBrowserClick({
          target,
          params: { worktree: runtimeWorktree, page: pageId },
          press,
          release,
          preferAtomicClick:
            atomic && mouseClickUnsupportedEnvironmentRef.current !== target.environmentId,
          onAtomicClickUnsupported: () => {
            mouseClickUnsupportedEnvironmentRef.current = target.environmentId
          }
        })
        scheduleRemoteTabInfoRefresh(operationToken, 250)
      } catch (error) {
        reportRemoteInputFailure(operationToken, pageId, error)
      }
    })
  }

  // A pointer that leaves the frame (when capture was refused) or a frame that loses focus ends the
  // gesture as far as this pane can tell. Keyed on whether a frame exists, not on which one: the
  // screencast mints a new frameUrl per frame, and re-running this per frame would tear down the
  // press mid-gesture.
  const hasRemoteFrame = frameUrl !== null
  useEffect(() => {
    const image = imageRef.current
    if (!image || !hasRemoteFrame) {
      return
    }
    const abandonPendingPress = (): void => {
      pendingPressRef.current?.abandon()
    }
    image.addEventListener('pointerleave', abandonPendingPress)
    image.addEventListener('blur', abandonPendingPress)
    return () => {
      image.removeEventListener('pointerleave', abandonPendingPress)
      image.removeEventListener('blur', abandonPendingPress)
    }
  }, [hasRemoteFrame, imageRef, pendingPressRef])

  // A pane torn down mid-hold would otherwise leave the remote button down for good.
  useEffect(
    () => () => {
      pendingPressRef.current?.abandon()
    },
    [pendingPressRef]
  )

  return { handleRemotePointerDown, handleRemotePointerUp, handleRemotePointerCancel }
}
