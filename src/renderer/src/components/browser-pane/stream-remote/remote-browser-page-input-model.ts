import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import type { BrowserTabInfo } from '../../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

export type RemoteBrowserRuntimeTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

export function decodeRemoteBrowserFrameUrl(url: string): Promise<void> {
  const image = new window.Image()
  image.decoding = 'async'
  image.src = url
  if (typeof image.decode === 'function') {
    return image.decode()
  }
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Remote browser frame failed to decode.'))
  })
}

export type RemoteBrowserContextMenu = {
  x: number
  y: number
  linkUrl: string | null
  pageUrl: string
  selectionText: string
}

export const REMOTE_BROWSER_FIND_UNAVAILABLE_NOTICE_ID = 'remote-browser-find-unavailable'

export type RemoteBrowserPaneNotice = {
  // An ID lets the owner deduplicate and retract its notice.
  id?: string
  kind: 'direct' | 'consequence'
  text: string
}

export type RemoteBrowserImagePoint = {
  x: number
  y: number
}

export type PendingRemoteBrowserWheel = {
  target: RemoteBrowserRuntimeTarget
  pageId: string
  operationToken: RemoteBrowserOperationToken
  point: RemoteBrowserImagePoint
  dx: number
  dy: number
}

export const WHEEL_DELTA_LINE = 1
export const WHEEL_DELTA_PAGE = 2

export type RemoteBrowserStreamBridge = {
  applyTabInfo: (tab: Pick<BrowserTabInfo, 'url' | 'title'>) => void
  clearFrame: () => void
  handleFrameBytes: (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>) => void
  closeMissingRemotePage: (remotePageId: string | null) => void
  waitForViewportSize: () => Promise<RemoteBrowserViewportSize | null>
  syncViewport: (pageId: string) => Promise<void>
}

export const NO_REMOTE_BROWSER_STREAM_BRIDGE: RemoteBrowserStreamBridge = {
  applyTabInfo: () => {},
  clearFrame: () => {},
  handleFrameBytes: () => {},
  closeMissingRemotePage: () => {},
  waitForViewportSize: async () => null,
  syncViewport: async () => {}
}

export function getRemoteBrowserMouseButton(button: number): 'left' | 'middle' | 'right' | null {
  if (button === 0) {
    return 'left'
  }
  if (button === 1) {
    return 'middle'
  }
  if (button === 2) {
    return 'right'
  }
  return null
}

/** Mouse back/forward buttons (DOM buttons 3 and 4) step the streamed page's history. */
export function getRemoteBrowserHistoryMethod(
  button: number
): 'browser.back' | 'browser.forward' | null {
  return button === 3 ? 'browser.back' : button === 4 ? 'browser.forward' : null
}

export function buildRemoteContextMenuExpression(x: number, y: number): string {
  return `(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    // Why: read the guest selection here so the remote/paired browser can offer
    // the same Copy affordance as the local webview (there is no ContextMenuParams
    // over the runtime RPC).
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    return JSON.stringify({
      linkUrl: anchor && anchor.href ? anchor.href : null,
      pageUrl: location.href || 'about:blank',
      selectionText: selection ? String(selection) : ''
    });
  })()`
}

export function readRemoteContextMenuResult(
  result: unknown
): Pick<RemoteBrowserContextMenu, 'linkUrl' | 'pageUrl' | 'selectionText'> | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const raw = (result as { result?: unknown }).result
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      linkUrl?: unknown
      pageUrl?: unknown
      selectionText?: unknown
    }
    return {
      linkUrl: typeof parsed.linkUrl === 'string' && parsed.linkUrl ? parsed.linkUrl : null,
      pageUrl:
        typeof parsed.pageUrl === 'string' && parsed.pageUrl ? parsed.pageUrl : 'about:blank',
      selectionText: typeof parsed.selectionText === 'string' ? parsed.selectionText : ''
    }
  } catch {
    return null
  }
}

export function readRemoteCssViewportSize(result: unknown): RemoteBrowserViewportSize | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const raw = (result as { result?: unknown }).result
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown }
    const width = getPositiveFiniteNumber(parsed.width)
    const height = getPositiveFiniteNumber(parsed.height)
    return width && height ? { width, height } : null
  } catch {
    return null
  }
}

// A later screencast subscriber can resize the shared page; trust per-frame dimensions once they diverge from our requested viewport, including during resize.
export function resolveRemoteBrowserCssViewport(input: {
  cssViewportSize: RemoteBrowserViewportSize | null
  requestedViewportSize: RemoteBrowserViewportSize | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  naturalSize: RemoteBrowserViewportSize
}): RemoteBrowserViewportSize {
  const deviceWidth = getPositiveFiniteNumber(input.frameMetadata?.deviceWidth)
  const deviceHeight = getPositiveFiniteNumber(input.frameMetadata?.deviceHeight)
  const requestedWidth = getPositiveFiniteNumber(input.requestedViewportSize?.width)
  const requestedHeight = getPositiveFiniteNumber(input.requestedViewportSize?.height)
  const framesMatchRequest =
    (deviceWidth === null || requestedWidth === null || deviceWidth === requestedWidth) &&
    (deviceHeight === null || requestedHeight === null || deviceHeight === requestedHeight)
  if (!framesMatchRequest) {
    return {
      width: deviceWidth ?? input.naturalSize.width,
      height: deviceHeight ?? input.naturalSize.height
    }
  }
  return {
    width:
      getPositiveFiniteNumber(input.cssViewportSize?.width) ??
      requestedWidth ??
      deviceWidth ??
      input.naturalSize.width,
    height:
      getPositiveFiniteNumber(input.cssViewportSize?.height) ??
      requestedHeight ??
      deviceHeight ??
      input.naturalSize.height
  }
}

// Map through the letterboxed image rect; pane coordinates do not identify the drawn page pixel.
export function mapRemoteBrowserClientPoint(input: {
  clientX: number
  clientY: number
  frameRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
  cssViewport: RemoteBrowserViewportSize
}): RemoteBrowserImagePoint | null {
  const { frameRect, cssViewport } = input
  if (
    frameRect.width <= 0 ||
    frameRect.height <= 0 ||
    cssViewport.width <= 0 ||
    cssViewport.height <= 0
  ) {
    return null
  }
  const x = ((input.clientX - frameRect.left) / frameRect.width) * cssViewport.width
  const y = ((input.clientY - frameRect.top) / frameRect.height) * cssViewport.height
  return {
    x: Math.round(Math.min(cssViewport.width, Math.max(0, x))),
    y: Math.round(Math.min(cssViewport.height, Math.max(0, y)))
  }
}

export function getPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function getRemoteBrowserDeviceScaleFactor(): number {
  if (typeof window === 'undefined') {
    return 1
  }
  const scale = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1
  return Math.min(2, Math.max(1, Number(scale.toFixed(2))))
}
