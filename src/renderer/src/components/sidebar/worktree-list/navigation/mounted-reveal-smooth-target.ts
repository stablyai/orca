import {
  getElementScrollBounds,
  getScrollTopToRevealBounds,
  resolveSidebarRevealScrollBehavior,
  stopSidebarRevealScroll,
  getElementSidebarRevealTopInset
} from '../../worktree-sidebar-reveal'
import { REVEAL_SCROLL_SETTLE_TIMEOUT_MS } from '../../worktree-sidebar-reveal-scroll-settle'

export function createMountedRevealSmoothTarget(
  container: HTMLElement,
  element: HTMLElement,
  behavior: ScrollBehavior,
  now: number
): { retargetUntil: number; retarget: (markScroll: (targetTop: number) => void) => void } | null {
  if (resolveSidebarRevealScrollBehavior(behavior) !== 'smooth') {
    return null
  }
  const topInset = getElementSidebarRevealTopInset(element)
  const initialBounds = getElementScrollBounds(container, element)
  const initialTarget = getScrollTopToRevealBounds(container, initialBounds, topInset)
  if (initialTarget === null) {
    return null
  }
  let oversized = initialBounds.end - initialBounds.start > container.clientHeight - topInset
  const edge = initialBounds.start < container.scrollTop + topInset || oversized ? 'start' : 'end'
  let issuedTarget = Math.max(0, initialTarget)
  let previousDistance = Math.abs(issuedTarget - container.scrollTop)
  return {
    // Bound new destinations; the latest issued motion retains its own settle window.
    retargetUntil: now + REVEAL_SCROLL_SETTLE_TIMEOUT_MS * 2,
    retarget: (markScroll) => {
      const bounds = getElementScrollBounds(container, element)
      oversized ||= bounds.end - bounds.start > container.clientHeight - topInset
      const target = Math.max(
        0,
        oversized ? bounds.start - topInset : initialTarget + bounds[edge] - initialBounds[edge]
      )
      if (
        (!oversized || Math.abs(target - container.scrollTop) <= 1) &&
        getScrollTopToRevealBounds(container, bounds, topInset) === null
      ) {
        // A fast native frame can reach the moved row before its new endpoint is issued.
        stopSidebarRevealScroll(container, markScroll)
        return
      }
      const distance = Math.abs(target - container.scrollTop)
      const closingDistance = Math.max(0, previousDistance - distance)
      previousDistance = distance
      // Cover the next measurement and animation frames when they close faster than the viewport.
      const approachDistance = Math.max(container.clientHeight * 3, closingDistance * 2)
      if (Math.abs(target - issuedTarget) <= 1 || distance > approachDistance) {
        return
      }
      // Retarget near the measured landing; restarting easing on every row stalls distant reveals.
      issuedTarget = target
      markScroll(target)
      container.scrollTo({ top: target, behavior: 'smooth' })
    }
  }
}
