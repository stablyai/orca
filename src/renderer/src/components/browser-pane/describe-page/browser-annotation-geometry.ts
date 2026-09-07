import { MessageCircleQuestionMark, PencilLine } from 'lucide-react'
import type {
  BrowserAnnotationPayload,
  BrowserAnnotationPriority,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import { translate } from '@/i18n/i18n'

export type BrowserOverlayAnchor = {
  x: number
  y: number
  below: boolean
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
export const PENDING_ANNOTATION_CARD_HEIGHT = 330

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

export function getBrowserOverlayAnchor(
  payload: BrowserGrabPayload,
  container: HTMLElement | null,
  webview: Electron.WebviewTag | null,
  viewport: BrowserOverlayViewport
): BrowserOverlayAnchor {
  const containerRect = container?.getBoundingClientRect()
  const webviewRect = webview?.getBoundingClientRect()
  const rect = getLiveBrowserAnnotationRect(payload, viewport)
  const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
  const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
  const elementBottom = offsetY + rect.y + rect.height
  const elementTop = offsetY + rect.y
  const containerWidth = containerRect?.width ?? 0
  const containerHeight = containerRect?.height ?? 0
  const below = elementBottom + PENDING_ANNOTATION_CARD_HEIGHT < containerHeight
  return {
    x: clampNumber(offsetX + rect.x + rect.width / 2, 12, Math.max(12, containerWidth - 12)),
    y: clampNumber(below ? elementBottom : elementTop, 12, Math.max(12, containerHeight - 12)),
    below
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
