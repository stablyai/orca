import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { BrowserAgentPointerPoint } from '../../../../../shared/browser/automation/browser-agent-activity-contract'
import type {
  BrowserScreencastDriverResult,
  BrowserScreencastPointer,
  BrowserScreencastReadyResult,
  BrowserScreencastResult
} from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-feature-interaction-source'
import { e2eConfig } from '@/app-shell/startup/e2e-config'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { isRemoteBrowserPageMissingCode } from './remote-browser-stream-errors'
import type { RemoteBrowserDialogPage } from './remote-browser-javascript-dialog'
import type { RemoteBrowserViewportSize } from './remote-browser-stream-tokens'
import type { RemoteBrowserPagePrompts } from './remote-browser-page-prompts'
import type { RemoteBrowserHostContextMenus } from './remote-browser-host-context-menus'
import { showRemoteBrowserDownloadNotice } from './remote-browser-download-notices'
import { saveRemoteBrowserPagePrint } from './remote-browser-page-print'
import { readBrowserScreencastFrameSeq } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

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

type E2eRemoteBrowserScreencastWindow = Window & {
  __remoteBrowserScreencastObserver?: { snapshot: () => { subscribeCount: number } }
}

let e2eScreencastSubscribeCount = 0

function recordE2eScreencastSubscribe(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  e2eScreencastSubscribeCount += 1
  const target = window as E2eRemoteBrowserScreencastWindow
  target.__remoteBrowserScreencastObserver ??= {
    snapshot: () => ({ subscribeCount: e2eScreencastSubscribeCount })
  }
}

// Guard ready/failure events here; frame and close handlers apply their own supersession checks.
export type RemoteBrowserScreencastEvents = {
  isCurrent: () => boolean
  onReady: (event: BrowserScreencastReadyResult) => void
  onEnded: () => void
  onFailed: (message: string) => void
  // Why: a transport-level error reports without closing the stream, which the runtime still owns.
  onTransportError: (message: string) => void
  onPageMissing: () => void
  onFrame: (bytes: Uint8Array<ArrayBufferLike>) => void
  /** The page's cursor and hovered link; null from hosts without `pointerEvents`. */
  onPointer: (pointer: BrowserScreencastPointer | null) => void
  /** Whether this stream reports the page's own menus, and the menus it reports. */
  hostContextMenus: Pick<RemoteBrowserHostContextMenus, 'setSupported' | 'deliver'>
  /** Where an agent points or presses on the page; hosts without `agentCursor` send none. */
  onAgentCursor: (point: BrowserAgentPointerPoint) => void
  /** Who drives the page, from `ready` on; hosts without `driverEvents` send none. */
  onDriver: (event: Omit<BrowserScreencastDriverResult, 'type'>) => void
  onClosed: () => void
  /** This stream's view of the page's dialog and prompts; they close with the stream. */
  pagePrompts: RemoteBrowserPagePrompts
}

export async function openRemoteBrowserScreencastStream(
  subscribe: RemoteBrowserScreencastSubscribe,
  request: RemoteBrowserScreencastRequest,
  events: RemoteBrowserScreencastEvents
): Promise<{ unsubscribe: () => void }> {
  recordE2eScreencastSubscribe()
  const dialogPage: RemoteBrowserDialogPage = {
    target: { kind: 'environment', environmentId: request.environmentId },
    worktree: request.worktree,
    pageId: request.pageId
  }
  // Set once `ready` echoes frameAck; hosts that strip the opt-in never get an ack.
  let ackSubscriptionId: string | null = null
  const subscription = await subscribe(
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
        // A viewport preset brings its own device; otherwise the page renders at this display's scale.
        deviceScaleFactor:
          request.viewportSize?.device?.deviceScaleFactor ?? request.deviceScaleFactor,
        mobile: request.viewportSize?.device?.mobile === true,
        // Pace by time, not by skipping frames: a skipped frame on a static page (one hover repaint) never arrives, while the host holds the newest paced frame.
        everyNthFrame: 1,
        minFrameIntervalMs: 33,
        pointerEvents: 1,
        pagePrompts: 1,
        contextMenus: 1,
        // A web client's picked files have no paths to stage on the host, and it can't save a printed PDF or a download.
        ...(isWebClientLocation() ? {} : { fileChoosers: 1, prints: 1, downloadCopies: 1 }),
        agentCursor: 1,
        driverEvents: 1,
        downloads: 1,
        // Frame credit keeps a slow link from queueing seconds of frames, and lowers quality while the page moves.
        frameAck: 1
      }),
      timeoutMs: 15_000
    },
    {
      onResponse: (response) => {
        const ready = readFrameAckReady(response)
        if (ready !== undefined) {
          ackSubscriptionId = ready
        }
        dispatchScreencastResponse(response, events, dialogPage)
      },
      onBinary: (bytes) => {
        const seq = readBrowserScreencastFrameSeq(bytes)
        if (ackSubscriptionId && seq !== null && events.isCurrent()) {
          // Cumulative, so a lost ack is covered by the next one.
          void callRuntimeRpc(
            dialogPage.target,
            'browser.screencast.ack',
            { subscriptionId: ackSubscriptionId, seq },
            { skipCompatibilityCheck: true, suppressFeatureInteraction: true, background: true }
          ).catch(() => {})
        }
        events.onFrame(bytes)
      },
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
      onClose: () => {
        events.pagePrompts.closeAll()
        events.onClosed()
      }
    }
  )
  return {
    unsubscribe: () => {
      events.pagePrompts.closeAll()
      subscription.unsubscribe()
    }
  }
}

/** The acked subscription from a `ready`, null when the host did not echo frameAck; undefined otherwise. */
function readFrameAckReady(response: RuntimeRpcResponse<unknown>): string | null | undefined {
  if (response.ok === false || !response.result || typeof response.result !== 'object') {
    return undefined
  }
  const event = response.result as BrowserScreencastResult
  if (event.type !== 'ready') {
    return undefined
  }
  return event.frameAck === true ? event.subscriptionId : null
}

function dispatchScreencastResponse(
  response: RuntimeRpcResponse<unknown>,
  events: RemoteBrowserScreencastEvents,
  dialogPage: RemoteBrowserDialogPage
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
    events.onPointer(event.pointer ?? null)
    events.hostContextMenus.setSupported(event.contextMenus === true)
  } else if (event.type === 'pointer') {
    events.onPointer({ cursor: event.cursor, targetUrl: event.targetUrl })
  } else if (event.type === 'contextMenu') {
    events.hostContextMenus.deliver(event)
  } else if (event.type === 'end') {
    events.onEnded()
  } else if (event.type === 'dialog') {
    events.pagePrompts.javaScriptDialog.show(event, dialogPage)
  } else if (event.type === 'dialogClosed') {
    events.pagePrompts.javaScriptDialog.close()
  } else if (event.type === 'pagePrompt') {
    events.pagePrompts.show(event.request, dialogPage)
  } else if (event.type === 'pagePromptClosed') {
    events.pagePrompts.close(event.requestId)
  } else if (event.type === 'fileChooser') {
    events.pagePrompts.chooseFiles(event.request, dialogPage)
  } else if (event.type === 'agentCursor') {
    const { x, y, viewportWidth, viewportHeight, press } = event
    events.onAgentCursor({ x, y, viewportWidth, viewportHeight, press })
  } else if (event.type === 'driver') {
    events.onDriver({ browserPageId: event.browserPageId, driver: event.driver })
  } else if (
    (event.type === 'downloadRequested' || event.type === 'downloadFinished') &&
    dialogPage.target.kind === 'environment'
  ) {
    showRemoteBrowserDownloadNotice(event, dialogPage.target)
  } else if (event.type === 'print') {
    void saveRemoteBrowserPagePrint(dialogPage, event)
  } else if (event.type === 'error') {
    events.onFailed(event.message)
  }
}
