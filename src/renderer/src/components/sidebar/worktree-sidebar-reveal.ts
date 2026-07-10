import { GROUP_HEADER_ROW_HEIGHT } from './worktree-list-virtual-rows'

const WORKTREE_REVEAL_TOP_CLEARANCE = 6
export const WORKTREE_SIDEBAR_REVEAL_TOP_INSET =
  GROUP_HEADER_ROW_HEIGHT + WORKTREE_REVEAL_TOP_CLEARANCE

type SidebarRevealBounds = {
  start: number
  end: number
}

function getElementScrollBounds(container: HTMLElement, element: Element): SidebarRevealBounds {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  return {
    start: elementRect.top - containerRect.top + container.scrollTop,
    end: elementRect.bottom - containerRect.top + container.scrollTop
  }
}

export function getScrollTopToRevealBounds(
  container: HTMLElement,
  bounds: SidebarRevealBounds,
  topInset = 0
): number {
  const viewportTopInset = Math.max(0, Math.min(container.clientHeight, topInset))
  // Why: the sticky header reduces the usable viewport, so center within the
  // visible area below it instead of behind it.
  const targetCenter = bounds.start + (bounds.end - bounds.start) / 2
  const viewportCenterOffset = (viewportTopInset + container.clientHeight) / 2
  return targetCenter - viewportCenterOffset
}

export function revealElementInScrollContainer(container: HTMLElement, element: Element): boolean {
  if (!container.contains(element)) {
    return false
  }
  const nextScrollTop = getScrollTopToRevealBounds(
    container,
    getElementScrollBounds(container, element),
    WORKTREE_SIDEBAR_REVEAL_TOP_INSET
  )
  // Why: sidebar reveal is a focus handoff, so reposition immediately instead
  // of making the user track an animated list. Boundary rows clamp to the list
  // edge — padding the list so they can center leaves a phantom gap behind.
  container.scrollTop = Math.max(0, nextScrollTop)
  return true
}
