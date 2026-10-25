import type { BrowserGrabRect } from './browser-grab-types'

/** What the bridge reports while a pending annotation card is open, in guest CSS pixels. */
export type BrowserAnnotationViewportReport = {
  scrollX: number
  scrollY: number
  /** Guest `innerWidth`; with the guest view's on-screen width it gives the page zoom scale. */
  viewportWidth?: number
  /** Live box of the selected element; absent when the guest no longer has it. */
  target?: BrowserGrabRect
}

export function isValidBrowserGrabRect(value: unknown): value is BrowserGrabRect {
  if (!value || typeof value !== 'object') {
    return false
  }
  const rect = value as Record<string, unknown>
  return (
    typeof rect.x === 'number' &&
    Number.isFinite(rect.x) &&
    typeof rect.y === 'number' &&
    Number.isFinite(rect.y) &&
    typeof rect.width === 'number' &&
    Number.isFinite(rect.width) &&
    rect.width >= 0 &&
    typeof rect.height === 'number' &&
    Number.isFinite(rect.height) &&
    rect.height >= 0
  )
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export function parseBrowserAnnotationViewportReport(
  json: string
): BrowserAnnotationViewportReport | null {
  let next: Partial<Record<keyof BrowserAnnotationViewportReport, unknown>> | null
  try {
    next = JSON.parse(json)
  } catch {
    return null
  }
  if (!next || typeof next !== 'object') {
    return null
  }
  const viewportWidth = finiteOr(next.viewportWidth, 0)
  return {
    scrollX: finiteOr(next.scrollX, 0),
    scrollY: finiteOr(next.scrollY, 0),
    ...(viewportWidth > 0 ? { viewportWidth } : {}),
    ...(isValidBrowserGrabRect(next.target) ? { target: next.target } : {})
  }
}
