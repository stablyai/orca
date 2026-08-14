import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  BrowserScreencastReadyResult,
  BrowserScreencastResult
} from '../../../../shared/runtime-types'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../../shared/runtime-rpc-feature-interaction-source'
import { isRemoteBrowserPageMissingCode } from './remote-browser-stream-errors'
import type { RemoteBrowserViewportSize } from './remote-browser-stream-tokens'

export type RemoteBrowserScreencastSubscribe = (
  args: { selector: string; method: string; params?: unknown; timeoutMs?: number },
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<unknown>) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  }
) => Promise<{ unsubscribe: () => void }>

export type RemoteBrowserScreencastRequest = {
  environmentId: string
  worktree: string
  pageId: string
  viewportSize: RemoteBrowserViewportSize | null
  deviceScaleFactor: number
}

// Why: isCurrent gates the two channels the runtime can deliver a stale event on; frames and close
// carry their own supersession checks downstream, so they are forwarded unguarded.
export type RemoteBrowserScreencastEvents = {
  isCurrent: () => boolean
  onReady: (event: BrowserScreencastReadyResult) => void
  onEnded: () => void
  onFailed: (message: string) => void
  // Why: a transport-level error reports without closing the stream, which the runtime still owns.
  onTransportError: (message: string) => void
  onPageMissing: () => void
  onFrame: (bytes: Uint8Array<ArrayBufferLike>) => void
  onClosed: () => void
}

// Translates one runtime screencast subscription's raw RPC envelope traffic into the semantic
// events a pane cares about.
export async function openRemoteBrowserScreencastStream(
  subscribe: RemoteBrowserScreencastSubscribe,
  request: RemoteBrowserScreencastRequest,
  events: RemoteBrowserScreencastEvents
): Promise<{ unsubscribe: () => void }> {
  return subscribe(
    {
      selector: request.environmentId,
      method: 'browser.screencast',
      params: withBrowserPaneUiRuntimeRpcSource({
        worktree: request.worktree,
        page: request.pageId,
        format: 'jpeg',
        quality: 70,
        maxWidth: 3840,
        maxHeight: 2160,
        viewportWidth: request.viewportSize?.width,
        viewportHeight: request.viewportSize?.height,
        deviceScaleFactor: request.deviceScaleFactor,
        everyNthFrame: 2
      }),
      timeoutMs: 15_000
    },
    {
      onResponse: (response) => dispatchScreencastResponse(response, events),
      onBinary: (bytes) => events.onFrame(bytes),
      onError: (error) => {
        if (!events.isCurrent()) {
          return
        }
        if (isRemoteBrowserPageMissingCode(error.code)) {
          events.onPageMissing()
          return
        }
        events.onTransportError(error.message)
      },
      onClose: () => events.onClosed()
    }
  )
}

function dispatchScreencastResponse(
  response: RuntimeRpcResponse<unknown>,
  events: RemoteBrowserScreencastEvents
): void {
  if (!events.isCurrent()) {
    return
  }
  if (response.ok === false) {
    if (isRemoteBrowserPageMissingCode(response.error.code)) {
      events.onPageMissing()
      return
    }
    events.onFailed(response.error.message)
    return
  }
  if (!response.result || typeof response.result !== 'object' || !('type' in response.result)) {
    return
  }
  const event = response.result as BrowserScreencastResult
  if (event.type === 'ready') {
    events.onReady(event)
  } else if (event.type === 'end') {
    events.onEnded()
  } else if (event.type === 'error') {
    events.onFailed(event.message)
  }
}
