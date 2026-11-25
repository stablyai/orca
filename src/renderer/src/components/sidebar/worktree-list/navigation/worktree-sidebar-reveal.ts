import { sidebarContentY } from '../viewport/sidebar-scroll-coordinates'
import { GROUP_HEADER_ROW_HEIGHT, HOST_STICKY_PINNED_HEIGHT } from '../viewport/virtual-rows'
import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'
import {
  requestVirtualizedScrollAnchorRecord,
  supersedeVirtualizedScrollAnchorRestore
} from '@/lib/list-interaction/virtualized-scrolling/requestVirtualizedScrollAnchorRecord'

const WORKTREE_REVEAL_TOP_CLEARANCE = 6
export const WORKTREE_SIDEBAR_REVEAL_TOP_INSET =
  GROUP_HEADER_ROW_HEIGHT + WORKTREE_REVEAL_TOP_CLEARANCE

// Why: with host sections the group pins beneath the pinned host card, so the inset must clear both tiers.
export function getWorktreeSidebarRevealTopInset(hasHostHeaders: boolean): number {
  return WORKTREE_SIDEBAR_REVEAL_TOP_INSET + (hasHostHeaders ? HOST_STICKY_PINNED_HEIGHT : 0)
}

// The range extractor keeps the pinned host mounted whenever host sections exist.
function getPinnedHeaderRevealInset(container: HTMLElement): number {
  return getWorktreeSidebarRevealTopInset(
    container.querySelector('[data-worktree-virtual-row-key^="host:"]') !== null
  )
}

export type SidebarRevealScroll = (top: number, behavior: ScrollBehavior) => void

type SidebarRevealBounds = {
  start: number
  end: number
}

export function getElementScrollBounds(
  container: HTMLElement,
  element: Element
): SidebarRevealBounds {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  return {
    start: sidebarContentY(container, elementRect.top, containerRect.top),
    end: sidebarContentY(container, elementRect.bottom, containerRect.top)
  }
}

export function getRevealTargetBounds(
  container: HTMLElement,
  element: Element
): SidebarRevealBounds | null {
  const bounds = getElementScrollBounds(container, element)
  if (
    !element.hasAttribute('data-worktree-id') &&
    !element.hasAttribute('data-worktree-card-surface')
  ) {
    return bounds
  }
  const first = element.firstElementChild
  const scope = first?.hasAttribute('data-worktree-context-menu-scope')
    ? first
    : first?.firstElementChild
  const surface = element.hasAttribute('data-worktree-card-surface')
    ? element
    : first?.hasAttribute('data-worktree-card-surface')
      ? first
      : scope?.hasAttribute('data-worktree-context-menu-scope')
        ? scope.firstElementChild
        : null
  if (!surface?.hasAttribute('data-worktree-card-surface')) {
    return null
  }
  const boundary = surface.lastElementChild
  return boundary?.hasAttribute('data-worktree-lineage-children')
    ? {
        start: bounds.start,
        end: Math.min(bounds.end, getElementScrollBounds(container, boundary).start)
      }
    : bounds
}

export function getScrollTopToRevealBounds(
  container: HTMLElement,
  bounds: SidebarRevealBounds,
  topInset = 0
): number | null {
  const viewportTopInset = Math.max(0, Math.min(container.clientHeight, topInset))
  const viewportTop = container.scrollTop + viewportTopInset
  const viewportBottom = container.scrollTop + container.clientHeight
  if (bounds.start < viewportTop) {
    return bounds.start - viewportTopInset
  }
  if (bounds.end > viewportBottom) {
    return bounds.end - container.clientHeight
  }
  return null
}

// 'partial' means clipped, with some part still showing below the sticky header inset.
export function getRevealBoundsVisibility(
  container: HTMLElement,
  bounds: SidebarRevealBounds
): 'full' | 'partial' | 'hidden' {
  const topInset = getPinnedHeaderRevealInset(container)
  if (getScrollTopToRevealBounds(container, bounds, topInset) === null) {
    return 'full'
  }
  const viewportTop = container.scrollTop + Math.min(container.clientHeight, topInset)
  const viewportBottom = container.scrollTop + container.clientHeight
  return bounds.end > viewportTop && bounds.start < viewportBottom ? 'partial' : 'hidden'
}

export function revealElementInScrollContainer(
  container: HTMLElement,
  element: Element,
  behavior: ScrollBehavior,
  // Notify guards to defer competing scrollTop writes until this smooth reveal finishes.
  onScrollIssued?: (targetTop: number) => void,
  scrollTo?: SidebarRevealScroll
): boolean {
  if (!container.contains(element)) {
    return false
  }
  const bounds = getRevealTargetBounds(container, element)
  if (!bounds) {
    return false
  }
  const containerTop = container.getBoundingClientRect().top
  const topInset = element.closest('[data-worktree-sticky-header-active]')
    ? 0
    : Math.max(
        getPinnedHeaderRevealInset(container),
        ...Array.from(
          container.querySelectorAll('[data-worktree-sticky-header-active]'),
          (header) =>
            (header.getBoundingClientRect().bottom - containerTop) /
              (container.currentCSSZoom || 1) +
            WORKTREE_REVEAL_TOP_CLEARANCE
        )
      )
  const leadingHeight = Math.max(
    0,
    container.clientHeight - Math.min(container.clientHeight, topInset)
  )
  const leadingBounds =
    bounds.end - bounds.start > leadingHeight
      ? { start: bounds.start, end: bounds.start + leadingHeight }
      : bounds
  const nextScrollTop = getScrollTopToRevealBounds(container, leadingBounds, topInset)
  // Short sidebars can clip the entire Projects scroller despite an internally visible row.
  const outer = container.closest<HTMLElement>('[data-sidebar-content-viewport]')
  if (outer && outer !== container) {
    let outerBounds = getElementScrollBounds(outer, container)
    if (container.clientHeight > outer.clientHeight) {
      const innerTop = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          nextScrollTop ?? container.scrollTop
        )
      )
      outerBounds = {
        start: outerBounds.start + bounds.start - innerTop,
        end: outerBounds.start + bounds.end - innerTop
      }
    }
    const outerTop =
      outerBounds.end - outerBounds.start > outer.clientHeight
        ? outerBounds.start
        : getScrollTopToRevealBounds(outer, outerBounds)
    // An already-visible target still supersedes the previous outer animation.
    outer.scrollTo({
      top: Math.max(0, outerTop ?? outer.scrollTop),
      behavior: outerTop === null ? 'instant' : motionSafeScrollBehavior(behavior)
    })
  }
  if (nextScrollTop === null) {
    supersedeVirtualizedScrollAnchorRestore(container)
    requestVirtualizedScrollAnchorRecord(container)
    return true
  }
  const targetTop = Math.max(0, nextScrollTop)
  supersedeVirtualizedScrollAnchorRestore(container, scrollTo ? undefined : targetTop)
  onScrollIssued?.(targetTop)
  const scrollBehavior = motionSafeScrollBehavior(behavior)
  if (scrollTo) {
    scrollTo(targetTop, scrollBehavior)
  } else {
    container.scrollTo({ top: targetTop, behavior: scrollBehavior })
  }
  requestVirtualizedScrollAnchorRecord(container)
  return true
}

export function revealCompactAgentCard(agentListRoot: HTMLElement | null): void {
  const sidebarElement = agentListRoot?.closest('[data-worktree-sidebar]')
  const worktreeOptionElement = agentListRoot?.closest('[role="option"]')
  if (!(sidebarElement instanceof HTMLElement) || !worktreeOptionElement) {
    return
  }
  revealElementInScrollContainer(sidebarElement, worktreeOptionElement, 'auto')
}
