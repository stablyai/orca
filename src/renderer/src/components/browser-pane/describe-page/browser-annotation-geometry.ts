import { MessageCircleQuestionMark, PencilLine } from 'lucide-react'
import type {
  BrowserAnnotationPayload,
  BrowserAnnotationPriority,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserPageAnnotation
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserAnnotationViewportReport } from '../../../../../shared/browser/annotations/browser-annotation-viewport-report'
import { translate } from '@/i18n/i18n'

export type BrowserOverlaySide = 'top' | 'bottom' | 'left' | 'right'

/** The pane and the guest's drawn surface (webview or streamed frame), narrowed to the measurement overlays need. */
type OverlayRect = { left: number; top: number; width: number; height: number }
export type OverlayRectSource = {
  getBoundingClientRect: () => OverlayRect
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
  /** Bumped when the pane moves or resizes so overlays re-measure; it never stands in for guest geometry. */
  version: number
  /** The guest's last report. Absent until one arrives, so capture-time scroll stays authoritative. */
  guest?: BrowserAnnotationViewportReport
}

export const INITIAL_BROWSER_OVERLAY_VIEWPORT: BrowserOverlayViewport = { version: 0 }

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

/** Maps guest CSS pixels into the container; the drawn surface differs from the guest viewport under page zoom or a scaled stream. */
export function mapGuestRectToContainer(
  rect: BrowserGrabRect,
  containerRect: OverlayRect | undefined,
  surfaceRect: OverlayRect | undefined,
  guestViewportWidth: number
): BrowserGrabRect {
  const scale =
    surfaceRect && surfaceRect.width > 0 && guestViewportWidth > 0
      ? surfaceRect.width / guestViewportWidth
      : 1
  return {
    x: (surfaceRect?.left ?? 0) - (containerRect?.left ?? 0) + rect.x * scale,
    y: (surfaceRect?.top ?? 0) - (containerRect?.top ?? 0) + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale
  }
}

export function getBrowserOverlayAnchor(
  payload: BrowserGrabPayload,
  container: OverlayRectSource | null,
  surface: OverlayRectSource | null,
  viewport: BrowserOverlayViewport,
  cardHeight: number | null = null
): BrowserOverlayAnchor {
  const containerRect = container?.getBoundingClientRect()
  const {
    x: elementLeft,
    y: elementTop,
    width,
    height
  } = mapGuestRectToContainer(
    getLiveBrowserAnnotationRect(payload, viewport),
    containerRect,
    surface?.getBoundingClientRect(),
    viewport.guest?.viewportWidth ?? payload.page.viewportWidth
  )
  const containerWidth = containerRect?.width ?? 0
  const containerHeight = containerRect?.height ?? 0
  const elementRight = elementLeft + width
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
  const guest = viewport.guest
  if (guest?.target) {
    return guest.target
  }
  if (payload.target.isFixed) {
    return payload.target.rectViewport
  }
  const scrollX = guest ? guest.scrollX : payload.page.scrollX
  const scrollY = guest ? guest.scrollY : payload.page.scrollY
  return {
    ...payload.target.rectViewport,
    x: payload.target.rectPage.x - scrollX,
    y: payload.target.rectPage.y - scrollY
  }
}

/** A new selection's card must not be placed by the box the guest measured for the previous one. */
export function forgetBrowserOverlayTarget(
  current: BrowserOverlayViewport
): BrowserOverlayViewport {
  return current.guest?.target
    ? { ...current, guest: { ...current.guest, target: undefined } }
    : current
}

/** Folds a guest viewport report in, keeping the same state object when nothing moved. */
export function applyBrowserAnnotationViewportReport(
  current: BrowserOverlayViewport,
  report: BrowserAnnotationViewportReport
): BrowserOverlayViewport {
  const guest = current.guest
  const unchanged =
    guest !== undefined &&
    guest.scrollX === report.scrollX &&
    guest.scrollY === report.scrollY &&
    guest.viewportWidth === report.viewportWidth &&
    sameRect(guest.target, report.target)
  return unchanged ? current : { version: current.version + 1, guest: report }
}

function sameRect(a: BrowserGrabRect | undefined, b: BrowserGrabRect | undefined): boolean {
  return (
    a === b ||
    (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
  )
}
