import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import { GROUP_HEADER_ROW_HEIGHT } from './worktree-list/viewport/virtual-rows'

const WORKTREE_REVEAL_TOP_CLEARANCE = 6
export const WORKTREE_SIDEBAR_REVEAL_TOP_INSET =
  GROUP_HEADER_ROW_HEIGHT + WORKTREE_REVEAL_TOP_CLEARANCE

export function getElementSidebarRevealTopInset(element: Element): number {
  const inset = Number(
    element.closest<HTMLElement>('[data-sidebar-reveal-top-inset]')?.dataset.sidebarRevealTopInset
  )
  return Number.isFinite(inset) && inset >= WORKTREE_SIDEBAR_REVEAL_TOP_INSET
    ? inset
    : WORKTREE_SIDEBAR_REVEAL_TOP_INSET
}

type SidebarRevealBounds = {
  start: number
  end: number
  titleEnd?: number
}

export function getElementScrollBounds(
  container: HTMLElement,
  element: Element
): SidebarRevealBounds {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const title =
    elementRect.height > container.clientHeight - getElementSidebarRevealTopInset(element)
      ? element.querySelector('[data-worktree-title-inline-rename]')?.getBoundingClientRect()
      : undefined
  return {
    ...(title && title.height > 0
      ? { titleEnd: title.bottom - containerRect.top + container.scrollTop }
      : {}),
    start: elementRect.top - containerRect.top + container.scrollTop,
    end: elementRect.bottom - containerRect.top + container.scrollTop
  }
}

export function getScrollTopToRevealBounds(
  container: Pick<HTMLElement, 'scrollTop' | 'clientHeight'>,
  bounds: SidebarRevealBounds,
  topInset = 0
): number | null {
  const viewportTopInset = Math.max(0, Math.min(container.clientHeight, topInset))
  const viewportTop = container.scrollTop + viewportTopInset
  const viewportBottom = container.scrollTop + container.clientHeight
  if (bounds.start < viewportTop) {
    return bounds.start - viewportTopInset
  }
  if (bounds.end - bounds.start > container.clientHeight - viewportTopInset) {
    const titleVisible = bounds.titleEnd !== undefined && bounds.titleEnd <= viewportBottom
    return titleVisible || Math.abs(bounds.start - viewportTop) <= 1
      ? null
      : bounds.start - viewportTopInset
  }
  if (bounds.end > viewportBottom) {
    return bounds.end - container.clientHeight
  }
  return null
}

export function revealElementInScrollContainer(
  container: HTMLElement,
  element: Element,
  behavior: ScrollBehavior,
  // Why: any other scrollTop write cancels the scroll issued here mid-animation;
  // callers use this to stand their scroll-position guards down until it lands.
  onScrollIssued?: (targetTop: number) => void
): boolean {
  if (!container.contains(element)) {
    return false
  }
  const nextScrollTop = getScrollTopToRevealBounds(
    container,
    getElementScrollBounds(container, element),
    getElementSidebarRevealTopInset(element)
  )
  if (nextScrollTop === null) {
    return true
  }
  const resolvedBehavior = resolveSidebarRevealScrollBehavior(behavior)
  const targetTop = Math.max(0, nextScrollTop)
  onScrollIssued?.(targetTop)
  container.scrollTo({ top: targetTop, behavior: resolvedBehavior })
  return true
}

export function resolveSidebarRevealScrollBehavior(behavior: ScrollBehavior): ScrollBehavior {
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  return behavior === 'smooth' && prefersReducedMotion ? 'auto' : behavior
}

export function stopSidebarRevealScroll(
  container: HTMLElement,
  onScrollIssued?: (targetTop: number) => void
): void {
  onScrollIssued?.(container.scrollTop)
  container.scrollTo({ top: container.scrollTop, behavior: 'auto' })
  container.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
}
