import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import {
  getElementScrollBounds,
  revealElementInScrollContainer,
  getElementSidebarRevealTopInset
} from '../../worktree-sidebar-reveal'
import { createMountedRevealSmoothTarget } from './mounted-reveal-smooth-target'
import { MAX_REVEAL_RETRIES } from './pending-reveal-inputs'

export function completeMountedSidebarReveal(args: {
  container: HTMLElement
  behavior: ScrollBehavior
  element: HTMLElement
  cancelled: () => boolean
  isScrollSettling: () => boolean
  wasScrollInterrupted: () => boolean
  markRevealScroll: (targetTop: number) => void
  scheduleFrame: (callback: FrameRequestCallback) => void
  beginRename?: () => void
  complete: (landed: boolean) => void
}): void {
  const complete = (landed: boolean): void => {
    if (args.cancelled()) {
      return
    }
    const input = args.element.querySelector<HTMLElement>('[data-worktree-title-rename-input]')
    if (
      !landed &&
      args.beginRename &&
      args.wasScrollInterrupted() &&
      args.container.contains(args.element) &&
      input &&
      input.closest('[data-worktree-row-key]') === args.element &&
      input === args.container.ownerDocument.activeElement
    ) {
      // Interrupted rename still exposes its editor, without reopening or reselecting it.
      revealElementInScrollContainer(args.container, input, 'auto')
    }
    args.complete(landed)
  }
  if (args.cancelled()) {
    return
  }
  if (!args.container.contains(args.element)) {
    complete(false)
    return
  }
  // Editing is ready at admission; native scrolling retains its own completion.
  args.beginRename?.()
  if (args.cancelled()) {
    return
  }
  if (!args.container.contains(args.element)) {
    complete(false)
    return
  }
  if (args.wasScrollInterrupted()) {
    // Let the admitted editor attach before preserving interrupted-rename visibility.
    if (args.beginRename) {
      args.scheduleFrame(() => complete(false))
    } else {
      complete(false)
    }
    return
  }
  if (!args.isScrollSettling()) {
    args.container.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
    complete(true)
    return
  }
  const smoothTarget = createMountedRevealSmoothTarget(
    args.container,
    args.element,
    args.behavior,
    window.performance.now()
  )
  const correctLanding = (attempt: number): void => {
    const previousScrollTop = args.container.scrollTop
    let expectedTop = args.element.getBoundingClientRect().top
    // Rows measured along the smooth-scroll path can move its landing position.
    const landed = revealElementInScrollContainer(
      args.container,
      args.element,
      'auto',
      (targetTop) => {
        const maximum = Math.max(0, args.container.scrollHeight - args.container.clientHeight)
        expectedTop += previousScrollTop - Math.min(targetTop, maximum)
        args.markRevealScroll(targetTop)
      }
    )
    if (landed) {
      // The correction replaces the anchor recorded during the smooth overshoot.
      args.container.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
    }
    args.scheduleFrame(() => {
      if (args.cancelled()) {
        return
      }
      if (!landed || !args.container.contains(args.element) || args.wasScrollInterrupted()) {
        complete(false)
        return
      }
      const rect = args.element.getBoundingClientRect()
      const viewportTop = args.container.getBoundingClientRect().top
      const viewportBottom = viewportTop + args.container.clientHeight
      const usableHeight =
        args.container.clientHeight - getElementSidebarRevealTopInset(args.element)
      const titleEnd =
        rect.height > usableHeight
          ? getElementScrollBounds(args.container, args.element).titleEnd
          : undefined
      const titleVisible =
        rect.top >= viewportTop - 1 &&
        rect.top < viewportBottom &&
        (titleEnd === undefined ||
          titleEnd <= args.container.scrollTop + args.container.clientHeight + 1)
      const endVisible = rect.bottom <= viewportBottom + 1 || rect.height > usableHeight
      if (Math.abs(rect.top - expectedTop) <= 1 && titleVisible && endVisible) {
        complete(true)
      } else if (attempt < MAX_REVEAL_RETRIES) {
        correctLanding(attempt + 1)
      } else {
        complete(false)
      }
    })
  }
  const finish = (): void => {
    if (args.cancelled()) {
      return
    }
    if (!args.container.contains(args.element) || args.wasScrollInterrupted()) {
      complete(false)
      return
    }
    if (args.isScrollSettling()) {
      // Retarget expiry cannot preempt the latest native motion's settle window.
      if (smoothTarget && window.performance.now() < smoothTarget.retargetUntil) {
        smoothTarget.retarget(args.markRevealScroll)
      }
      args.scheduleFrame(finish)
      return
    }
    correctLanding(0)
  }
  args.scheduleFrame(finish)
}
