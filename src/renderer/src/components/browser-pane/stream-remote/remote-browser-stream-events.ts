import {
  REMOTE_BROWSER_STREAM_LIVE,
  remoteBrowserStreamLostNotice,
  remoteBrowserStreamStopped
} from './remote-browser-stream-status'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import type { RemoteBrowserScreencastEvents } from './remote-browser-screencast-subscription'
import type {
  RemoteBrowserOperationTokens,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import { recoverRemoteBrowserFirstFrame } from './remote-browser-first-frame-recovery'

type RemoteBrowserStreamEventDeps = Pick<
  RemoteBrowserStreamLifecycleDeps,
  | 'applyTabInfo'
  | 'callRpc'
  | 'closeMissingRemotePage'
  | 'getWorktreeSelector'
  | 'handleFrameBytes'
  | 'setStatus'
  | 'syncViewport'
> & {
  tokens: RemoteBrowserOperationTokens
  liveness: RemoteBrowserStreamLiveness
  handleClosed: (restart: boolean) => void
  onSubscriptionStart?: (handle: { unsubscribe: () => void }) => void
}

export function createRemoteBrowserStreamEvents(
  pageId: string,
  token: RemoteBrowserStreamToken,
  viewportSize: RemoteBrowserViewportSize | null,
  deps: RemoteBrowserStreamEventDeps
): RemoteBrowserScreencastEvents {
  return {
    isCurrent: () => deps.tokens.isCurrentStreamToken(token),
    onReady: (event) => {
      const transition = deps.liveness.markReady(() => recoverRemoteBrowserFirstFrame(token, deps))
      if (transition === 'ignored') {
        return
      }
      if (transition === 'live') {
        deps.setStatus(REMOTE_BROWSER_STREAM_LIVE)
      }
      deps.applyTabInfo(event.tab)
      void deps.syncViewport(event.browserPageId, viewportSize).catch(() => {})
    },
    onEnded: () => deps.handleClosed(true),
    onFailed: (message) => {
      deps.setStatus(remoteBrowserStreamStopped(message))
      deps.handleClosed(false)
    },
    // Transport errors can arrive without close; stop the ready deadline and leave Reconnect usable.
    onTransportError: () => {
      deps.liveness.stopWaitingForReady()
      deps.setStatus(remoteBrowserStreamStopped(remoteBrowserStreamLostNotice()))
    },
    onPageMissing: () => deps.closeMissingRemotePage(pageId),
    onFrame: (bytes) => {
      if (!deps.tokens.isCurrentStreamToken(token)) {
        return
      }
      const transition = deps.liveness.markFrame()
      if (transition === 'ignored') {
        return
      }
      if (transition === 'live') {
        deps.setStatus(REMOTE_BROWSER_STREAM_LIVE)
      }
      deps.handleFrameBytes(token, bytes)
    },
    onClosed: () => deps.handleClosed(true),
    onSubscriptionStart: deps.onSubscriptionStart
  }
}
