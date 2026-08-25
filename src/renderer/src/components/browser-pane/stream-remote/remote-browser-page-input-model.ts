import type { BrowserTabInfo } from '../../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
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

export type RemoteBrowserPaneNotice = {
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

// The pane-owned effects the stream lifecycle calls back into: frame paint, viewport measurement,
// and the store/tab-close decision for a page that is gone.
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

export type RemoteBrowserPressState = {
  environmentId: string
  pageId: string
  button: 'left' | 'middle'
  point: RemoteBrowserImagePoint
  modified: boolean
}

// A press held this long is an interaction in its own right (long-press menu, hold-to-repeat,
// drag-start affordance, :active feedback), so the button goes down on the page now instead of
// waiting for a release that would compress the whole hold into one instantaneous click.
export const REMOTE_BROWSER_PRESS_HOLD_MS = 350

// Backstop for a press whose hold never armed the button (a suspended or throttled renderer can
// stall the hold timer): past this it is stale, and replaying it would fabricate a press the user
// never made at coordinates the page has since scrolled away from.
export const REMOTE_BROWSER_PRESS_MAX_AGE_MS = 5_000

export type PendingRemoteBrowserPress = {
  press: RemoteBrowserPressState
  target: RemoteBrowserRuntimeTarget
  operationToken: RemoteBrowserOperationToken
  pointerId: number
  pressedAt: number
  holdTimer: number | null
  // Set when the hold put the button down remotely; the release then only has to lift it.
  holdDispatched: boolean
  // Drops the press, releasing the remote button first when the hold already put it down.
  abandon: () => void
}

// Mouse jitter inside a press; wider slop would swallow short intentional drags.
const REMOTE_BROWSER_CLICK_SLOP_PX = 3

export function hasRemoteBrowserClickModifier(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
}

// Why: only a same-target, unmodified, non-drag pair is reproducible as one atomic browser.mouseClick;
// modifiers change activation semantics and the move/down/up chain carries none of them.
export function isSimpleRemoteBrowserClick(
  press: RemoteBrowserPressState,
  release: RemoteBrowserPressState
): boolean {
  if (
    press.environmentId !== release.environmentId ||
    press.pageId !== release.pageId ||
    press.button !== release.button ||
    press.modified ||
    release.modified
  ) {
    return false
  }
  return (
    Math.hypot(release.point.x - press.point.x, release.point.y - press.point.y) <=
    REMOTE_BROWSER_CLICK_SLOP_PX
  )
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
