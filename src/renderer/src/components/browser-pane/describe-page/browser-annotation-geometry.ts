import { MessageCircleQuestionMark, PencilLine } from 'lucide-react'
import type {
  BrowserAnnotationPayload,
  BrowserAnnotationPriority,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import type { BrowserAnnotationViewportReport } from '../../../../../shared/browser-annotation-viewport-report'
import { translate } from '@/i18n/i18n'

export type BrowserOverlaySide = 'top' | 'bottom' | 'left' | 'right'

/** The pane and the guest view, narrowed to the measurement the anchor needs from each. */
type OverlayRectSource = {
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number }
}

export type BrowserOverlayAnchor = {
  x: number
  y: number
  side: BrowserOverlaySide
}

export const BROWSER_ANNOTATION_INTENT_OPTIONS = [
  {
    value: 'change',
    get label() {
      return translate('auto.components.browser.pane.BrowserPane.143204e423', 'Change')
    },
    icon: PencilLine
  },
  {
    value: 'question',
    get label() {
      return translate('auto.components.browser.pane.BrowserPane.b5ba6085de', 'Question')
    },
    icon: MessageCircleQuestionMark
  }
] as const

// Why: priority stays in the persisted annotation shape for backwards compat, though the UI no longer exposes urgency choices.
export const DEFAULT_BROWSER_ANNOTATION_PRIORITY: BrowserAnnotationPriority = 'important'
export const BROWSER_PAGE_ZOOM_FEEDBACK_MS = 1400

export type BrowserOverlayViewport = {
  scrollX: number
  scrollY: number
  version: number
  /** Guest `innerWidth` at the last report. */
  viewportWidth?: number
  /** Live box of the pending selection, re-measured by the guest; absent until it reports one. */
  target?: BrowserGrabRect
}

export const EMPTY_BROWSER_ANNOTATIONS: BrowserPageAnnotation[] = []

// Use fixed CSS width to avoid feedback from side-dependent squeezing; fallback height lasts only until the card measures itself.
const PENDING_ANNOTATION_CARD_HEIGHT = 240
const PENDING_ANNOTATION_CARD_WIDTH = 352
// PopoverContent's sideOffset (10) plus its collisionPadding (12).
const PENDING_ANNOTATION_CARD_MARGIN = 22

export function createBrowserAnnotationId(): string {
  return `browser-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createBrowserAnnotationPayload(
  payload: BrowserGrabPayload
): BrowserAnnotationPayload {
  return {
    ...payload,
    // Why: annotations are persisted; screenshot data is a transient copy payload that can be megabytes per selection.
    screenshot: null
  }
}

// Preference order: a later side is only reached when every earlier one is too tight.
const BROWSER_OVERLAY_SIDES = ['bottom', 'top', 'right', 'left'] as const

/** Try all sides: Radix shifts a card back over its target if the chosen free band cannot hold it. */
function pickBrowserOverlaySide(
  space: Record<BrowserOverlaySide, number>,
  cardHeight: number
): BrowserOverlaySide {
  const vertical = cardHeight + PENDING_ANNOTATION_CARD_MARGIN
  const horizontal = PENDING_ANNOTATION_CARD_WIDTH + PENDING_ANNOTATION_CARD_MARGIN
  const room: Record<BrowserOverlaySide, number> = {
    bottom: space.bottom / vertical,
    top: space.top / vertical,
    right: space.right / horizontal,
    left: space.left / horizontal
  }
  const fitting = BROWSER_OVERLAY_SIDES.find((side) => room[side] >= 1)
  // When nothing fits, choose the deeper vertical band and let Radix keep the card on screen rather than disabling collisions.
  return fitting ?? (room.bottom >= room.top ? 'bottom' : 'top')
}

export function getBrowserOverlayAnchor(
  payload: BrowserGrabPayload,
  container: OverlayRectSource | null,
  webview: OverlayRectSource | null,
  viewport: BrowserOverlayViewport,
  cardHeight: number | null = null
): BrowserOverlayAnchor {
  const containerRect = container?.getBoundingClientRect()
  const webviewRect = webview?.getBoundingClientRect()
  const rect = getLiveBrowserAnnotationRect(payload, viewport)
  // Guest pixels differ from pane pixels whenever page zoom differs from the app's zoom.
  const guestWidth = viewport.viewportWidth ?? payload.page.viewportWidth
  const scale =
    webviewRect && webviewRect.width > 0 && guestWidth > 0 ? webviewRect.width / guestWidth : 1
  const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
  const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
  const containerWidth = containerRect?.width ?? 0
  const containerHeight = containerRect?.height ?? 0
  const width = rect.width * scale
  const height = rect.height * scale
  const elementLeft = offsetX + rect.x * scale
  const elementRight = elementLeft + width
  const elementTop = offsetY + rect.y * scale
  const elementBottom = elementTop + height
  const side = pickBrowserOverlaySide(
    {
      top: elementTop,
      bottom: containerHeight - elementBottom,
      left: elementLeft,
      right: containerWidth - elementRight
    },
    cardHeight ?? PENDING_ANNOTATION_CARD_HEIGHT
  )
  const edge = {
    top: { x: elementLeft + width / 2, y: elementTop },
    bottom: { x: elementLeft + width / 2, y: elementBottom },
    left: { x: elementLeft, y: elementTop + height / 2 },
    right: { x: elementRight, y: elementTop + height / 2 }
  }[side]
  return {
    x: clampNumber(edge.x, 12, Math.max(12, containerWidth - 12)),
    y: clampNumber(edge.y, 12, Math.max(12, containerHeight - 12)),
    side
  }
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function getLiveBrowserAnnotationRect(
  payload: BrowserGrabPayload,
  viewport: BrowserOverlayViewport
): BrowserGrabRect {
  if (viewport.target) {
    return viewport.target
  }
  if (payload.target.isFixed) {
    return payload.target.rectViewport
  }
  const scrollX = viewport.version === 0 ? payload.page.scrollX : viewport.scrollX
  const scrollY = viewport.version === 0 ? payload.page.scrollY : viewport.scrollY
  return {
    ...payload.target.rectViewport,
    x: payload.target.rectPage.x - scrollX,
    y: payload.target.rectPage.y - scrollY
  }
}

/** Folds a guest viewport report in, keeping the same state object when nothing moved. */
export function applyBrowserAnnotationViewportReport(
  current: BrowserOverlayViewport,
  report: BrowserAnnotationViewportReport
): BrowserOverlayViewport {
  const unchanged =
    current.scrollX === report.scrollX &&
    current.scrollY === report.scrollY &&
    current.viewportWidth === report.viewportWidth &&
    sameRect(current.target, report.target)
  if (unchanged) {
    return current.version === 0 ? { ...current, version: 1 } : current
  }
  return { ...report, version: current.version + 1 }
}

function sameRect(a: BrowserGrabRect | undefined, b: BrowserGrabRect | undefined): boolean {
  return (
    a === b ||
    (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
  )
}
