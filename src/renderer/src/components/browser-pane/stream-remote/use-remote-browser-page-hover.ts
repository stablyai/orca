import { useEffect, useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type {
  LatestRemoteBrowserInput,
  RemoteBrowserInputQueue
} from './remote-browser-input-queue'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

type RemoteBrowserHoverMove = {
  target: RemoteBrowserRuntimeTarget
  worktree: string
  pageId: string
  operationToken: RemoteBrowserOperationToken
  point: { x: number; y: number }
}

const noWork = Promise.resolve()
// Off the page, so a leave clears hover and the hovered link as a local guest's mouseleave does.
const OFF_PAGE_POINT = { x: -1, y: -1 }

/** Forwards pointer moves (hover and drag) and leaves, so the page sees the pointer as a local one would. */
export function useRemoteBrowserPageHover({
  busy,
  inputQueue,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  getRemoteImagePoint
}: {
  busy: boolean
  inputQueue: RemoteBrowserInputQueue
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
}): (event: React.PointerEvent<HTMLImageElement>) => void {
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

  return (event) => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = event.type === 'pointerleave' ? OFF_PAGE_POINT : getRemoteImagePoint(event)
    if (!target || !pageId || !operationToken || !point) {
      return
    }
    hoverRef.current?.push({ target, worktree: runtimeWorktree, pageId, operationToken, point })
  }
}

// Latest-wins with one move in flight, so a slow host gets fewer, newer points and a drag stays
// continuous. A dropped move is replaced by the next one, so failures stay silent.
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
