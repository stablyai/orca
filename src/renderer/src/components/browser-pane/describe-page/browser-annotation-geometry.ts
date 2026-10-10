import { MessageCircleQuestionMark, PencilLine } from 'lucide-react'
import type {
  BrowserAnnotationPayload,
  BrowserAnnotationPriority,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
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
}

export const EMPTY_BROWSER_ANNOTATIONS: BrowserPageAnnotation[] = []

// Footprint of PendingBrowserAnnotationCard (measured at 352x237), rounded up: it never grows
// past this, so a band narrower than it plus the margin below cannot hold the card.
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

/**
 * Side of the target whose free band can hold the card.
 *
 * Why every side and not just below/above: Radix shifts a popover back along its own axis when
 * the named side cannot hold it, so naming a side that does not fit lands the card *on* the
 * target instead of beside it. A tall target, or a short pane, leaves neither vertical band deep
 * enough — the horizontal ones usually still are.
 */
function pickBrowserOverlaySide(space: Record<BrowserOverlaySide, number>): BrowserOverlaySide {
  const vertical = PENDING_ANNOTATION_CARD_HEIGHT + PENDING_ANNOTATION_CARD_MARGIN
  const horizontal = PENDING_ANNOTATION_CARD_WIDTH + PENDING_ANNOTATION_CARD_MARGIN
  const room: Record<BrowserOverlaySide, number> = {
    bottom: space.bottom / vertical,
    top: space.top / vertical,
    right: space.right / horizontal,
    left: space.left / horizontal
  }
  const fitting = BROWSER_OVERLAY_SIDES.find((side) => room[side] >= 1)
  // No band fits, so overlap is unavoidable and Radix still flips and shifts to keep the card
  // on screen — the deeper vertical band only makes it overlap least. Letting it cover part of
  // the target beats the alternatives (anchoring to the target rect, or turning collision
  // handling off), which both park ~95% of the composer outside the pane.
  return fitting ?? (room.bottom >= room.top ? 'bottom' : 'top')
}

export function getBrowserOverlayAnchor(
  payload: BrowserGrabPayload,
  container: OverlayRectSource | null,
  webview: OverlayRectSource | null,
  viewport: BrowserOverlayViewport
): BrowserOverlayAnchor {
  const containerRect = container?.getBoundingClientRect()
  const webviewRect = webview?.getBoundingClientRect()
  const rect = getLiveBrowserAnnotationRect(payload, viewport)
  const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
  const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
  const containerWidth = containerRect?.width ?? 0
  const containerHeight = containerRect?.height ?? 0
  const elementLeft = offsetX + rect.x
  const elementRight = elementLeft + rect.width
  const elementTop = offsetY + rect.y
  const elementBottom = elementTop + rect.height
  const side = pickBrowserOverlaySide({
    top: elementTop,
    bottom: containerHeight - elementBottom,
    left: elementLeft,
    right: containerWidth - elementRight
  })
  const edge = {
    top: { x: elementLeft + rect.width / 2, y: elementTop },
    bottom: { x: elementLeft + rect.width / 2, y: elementBottom },
    left: { x: elementLeft, y: elementTop + rect.height / 2 },
    right: { x: elementRight, y: elementTop + rect.height / 2 }
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
