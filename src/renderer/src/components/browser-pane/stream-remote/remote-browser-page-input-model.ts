import { z } from 'zod'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { BrowserPageContextMenuState } from '../describe-page/browser-page-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
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
  applyTabInfo: (tab: BrowserTabInfo) => void
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

const MAX_CONTEXT_MENU_IMAGE_URL_LENGTH = 256 * 1024

/** What the page under a right-click offers, read in the streamed page since no ContextMenuParams cross the runtime RPC. */
export function buildRemoteContextMenuExpression(x: number, y: number): string {
  return `(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const closest = (selector) => target && typeof target.closest === 'function' ? target.closest(selector) : null;
    const anchor = closest('a[href]');
    const image = closest('img');
    const NON_TEXT_INPUTS = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
    const field = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.includes(target.type)) ? target : null;
    // A click inside a contenteditable editor lands on a descendant; its editing host is what takes focus.
    let editableTarget = field || (target && target.isContentEditable ? target : null);
    while (!field && editableTarget && editableTarget.parentElement && editableTarget.parentElement.isContentEditable) {
      editableTarget = editableTarget.parentElement;
    }
    const writable = Boolean(editableTarget) && !(field && (field.readOnly || field.disabled));
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    // Like a native right-click, an editable field takes focus so the edit items act on it.
    if (editableTarget && document.activeElement !== editableTarget && !editableTarget.contains(document.activeElement)) {
      editableTarget.focus({ preventScroll: true });
    }
    // ...and a click outside the editor's selection moves the caret to the pointer.
    if (!field && editableTarget && selection && typeof document.caretRangeFromPoint === 'function') {
      const inSelection = !selection.isCollapsed && selection.rangeCount && Array.from(selection.getRangeAt(0).getClientRects()).some((rect) =>
        ${JSON.stringify(x)} >= rect.left && ${JSON.stringify(x)} <= rect.right && ${JSON.stringify(y)} >= rect.top && ${JSON.stringify(y)} <= rect.bottom);
      const caret = inSelection ? null : document.caretRangeFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (caret && editableTarget.contains(caret.startContainer)) {
        selection.removeAllRanges();
        selection.addRange(caret);
      }
    }
    // Some input types (email, number) expose no selection offsets; the document selection still holds their text.
    const selectionText = field && typeof field.selectionStart === 'number'
      ? field.value.slice(field.selectionStart, field.selectionEnd)
      : (selection ? String(selection) : '');
    const commandEnabled = (command) => { try { return document.queryCommandEnabled(command); } catch { return true; } };
    const hidden = field && field.type === 'password';
    return JSON.stringify({
      linkUrl: anchor && anchor.href ? anchor.href : null,
      pageUrl: location.href || 'about:blank',
      selectionText: hidden ? '' : selectionText,
      // Why capped: a large inline data: image would push the reply past the runtime's size limit.
      imageUrl: image && (image.currentSrc || image.src || '').length <= ${MAX_CONTEXT_MENU_IMAGE_URL_LENGTH} ? image.currentSrc || image.src || null : null,
      editable: editableTarget ? {
        canUndo: writable && commandEnabled('undo'),
        canRedo: writable && commandEnabled('redo'),
        canCut: writable && !hidden && Boolean(selectionText),
        canCopy: !hidden && Boolean(selectionText),
        canPaste: writable,
        canSelectAll: !(field && field.disabled)
      } : null
    });
  })()`
}

/** The JSON a page expression returned through browser.eval, or null when it returned none. */
export function readRemoteBrowserEvalJson(result: unknown): unknown {
  const raw = result && typeof result === 'object' && 'result' in result ? result.result : null
  if (typeof raw !== 'string') {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const RemoteContextMenuResult = z.object({
  linkUrl: z.string().nullable().catch(null),
  pageUrl: z.string().catch(''),
  selectionText: z.string().catch(''),
  imageUrl: z.string().nullable().catch(null),
  editable: z
    .object({
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      canCut: z.boolean(),
      canCopy: z.boolean(),
      canPaste: z.boolean(),
      canSelectAll: z.boolean()
    })
    .nullable()
    .catch(null)
})

export function readRemoteContextMenuResult(
  result: unknown
): Pick<
  BrowserPageContextMenuState,
  'linkUrl' | 'pageUrl' | 'selectionText' | 'editable' | 'image'
> | null {
  const parsed = RemoteContextMenuResult.safeParse(readRemoteBrowserEvalJson(result))
  if (!parsed.success) {
    return null
  }
  const { linkUrl, pageUrl, selectionText, imageUrl, editable } = parsed.data
  return {
    linkUrl: linkUrl || null,
    pageUrl: pageUrl || 'about:blank',
    selectionText,
    // Copy Image needs the page's pixels on this machine, so streamed menus leave it out.
    image: imageUrl ? { url: imageUrl, canCopy: false } : null,
    editable: editable ? { ...editable, spelling: { suggestions: [], misspelledWord: '' } } : null
  }
}

export function readRemoteCssViewportSize(result: unknown): RemoteBrowserViewportSize | null {
  const parsed = readRemoteBrowserEvalJson(result)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const width = getPositiveFiniteNumber('width' in parsed ? parsed.width : null)
  const height = getPositiveFiniteNumber('height' in parsed ? parsed.height : null)
  return width && height ? { width, height } : null
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
  // Sizes in device pixels cover fewer CSS pixels on a zoomed page.
  const zoom = getPositiveFiniteNumber(input.frameMetadata?.zoomFactor) ?? 1
  const framesMatchRequest =
    (deviceWidth === null || requestedWidth === null || deviceWidth === requestedWidth) &&
    (deviceHeight === null || requestedHeight === null || deviceHeight === requestedHeight)
  if (!framesMatchRequest) {
    return {
      width: (deviceWidth ?? input.naturalSize.width) / zoom,
      height: (deviceHeight ?? input.naturalSize.height) / zoom
    }
  }
  return {
    width:
      getPositiveFiniteNumber(input.cssViewportSize?.width) ??
      (requestedWidth ?? deviceWidth ?? input.naturalSize.width) / zoom,
    height:
      getPositiveFiniteNumber(input.cssViewportSize?.height) ??
      (requestedHeight ?? deviceHeight ?? input.naturalSize.height) / zoom
  }
}

/** The drawn frame's screen rect and the page viewport it shows, in CSS pixels. */
export function readRemoteBrowserFrameGeometry(
  image: HTMLImageElement,
  sizes: {
    cssViewportSize: RemoteBrowserViewportSize | null
    requestedViewportSize: RemoteBrowserViewportSize | null
    frameMetadata: BrowserScreencastFrameMetadata | null
  }
): { frameRect: DOMRect; cssViewport: RemoteBrowserViewportSize } {
  return {
    frameRect: image.getBoundingClientRect(),
    cssViewport: resolveRemoteBrowserCssViewport({
      ...sizes,
      naturalSize: { width: image.naturalWidth, height: image.naturalHeight }
    })
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

/** Where a page-space rect is drawn on screen: the inverse of mapRemoteBrowserClientPoint. */
export function mapRemoteBrowserPageRect(input: {
  rect: { x: number; y: number; width: number; height: number }
  frameRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
  cssViewport: RemoteBrowserViewportSize
}): { left: number; top: number; width: number; height: number } | null {
  const { rect, frameRect, cssViewport } = input
  if (cssViewport.width <= 0 || cssViewport.height <= 0) {
    return null
  }
  const scaleX = frameRect.width / cssViewport.width
  const scaleY = frameRect.height / cssViewport.height
  return {
    left: frameRect.left + rect.x * scaleX,
    top: frameRect.top + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
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
