import {
  COMBINED_DIFF_HEADER_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_VIEWPORT_SELECTOR
} from './combined-diff-viewport'

export function getCombinedDiffCodeRect(node: HTMLElement): DOMRect {
  const rect = node.getBoundingClientRect()
  const viewport = node.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  if (!viewport) {
    return rect
  }
  const outer = viewport.getBoundingClientRect()
  const header = node
    .closest(COMBINED_DIFF_ROW_SELECTOR)
    ?.querySelector(COMBINED_DIFF_HEADER_SELECTOR)
  const top = Math.max(
    rect.top,
    outer.top + viewport.clientTop + (header?.getBoundingClientRect().height ?? 0)
  )
  const bottom = Math.max(
    top,
    Math.min(rect.bottom, outer.top + viewport.clientTop + viewport.clientHeight)
  )
  const left = Math.max(rect.left, outer.left + viewport.clientLeft)
  const right = Math.max(
    left,
    Math.min(rect.right, outer.left + viewport.clientLeft + viewport.clientWidth)
  )
  return new DOMRect(left, top, right - left, bottom - top)
}

export function getCombinedDiffSlice(
  content: number,
  viewport: number,
  header: number,
  bodyTop: number,
  scroll: number
): { height: number; offset: number } {
  const height = Math.max(1, Math.min(content, Math.max(1, viewport - header)))
  return { height, offset: Math.max(0, Math.min(content - height, scroll + header - bodyTop)) }
}

export function resolveCombinedDiffReveal(
  scroll: number,
  viewport: number,
  header: number,
  top: number,
  bottom: number,
  policy: number,
  minimal = false
): number {
  const start = scroll + header
  const end = scroll + viewport
  const visible = top >= start && bottom <= end
  if (minimal && top < end && bottom > start) {
    return scroll
  }
  if ((policy === 2 || policy === 6) && visible) {
    return scroll
  }
  if (policy === 1 || policy === 2) {
    return Math.max(0, (top + bottom - viewport - header) / 2)
  }
  if (policy === 3) {
    return Math.max(0, top - header)
  }
  if (policy === 4) {
    return Math.max(0, bottom - viewport)
  }
  if (policy === 5 || policy === 6) {
    return Math.max(0, bottom - viewport, top - header - (viewport - header) * 0.2)
  }
  return Math.max(0, top < start ? top - header : bottom > end ? bottom - viewport : scroll)
}
