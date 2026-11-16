import {
  COMBINED_DIFF_VIEWPORT_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_HEADER_SELECTOR
} from './combined-diff-viewport'
import { hasLayoutBox } from '@/hooks/virtualized-hidden-row-measurement'

export function revealCombinedDiffCursor(
  root: HTMLElement,
  cursor: { top: number; height: number }
): void {
  const viewport = root.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  if (!viewport || !hasLayoutBox(root) || !hasLayoutBox(viewport)) {
    return
  }
  const header = root
    .closest(COMBINED_DIFF_ROW_SELECTOR)
    ?.querySelector<HTMLElement>(COMBINED_DIFF_HEADER_SELECTOR)
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
  const visibleTop = viewportTop + (header?.getBoundingClientRect().height ?? 0)
  const visibleBottom = viewportTop + viewport.clientHeight
  const delta =
    cursor.top < visibleTop
      ? cursor.top - visibleTop
      : Math.max(0, cursor.top + cursor.height - visibleBottom)
  if (delta !== 0) {
    viewport.scrollTop += delta
  }
}
