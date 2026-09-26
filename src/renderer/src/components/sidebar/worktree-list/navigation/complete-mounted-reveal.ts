import { revealElementInScrollContainer } from '../../worktree-sidebar-reveal'

export function completeMountedSidebarReveal(args: {
  container: HTMLElement
  element: HTMLElement
  cancelled: () => boolean
  isScrollSettling: () => boolean
  wasScrollInterrupted: () => boolean
  markRevealScroll: (targetTop: number) => void
  scheduleFrame: (callback: FrameRequestCallback) => void
  complete: (landed: boolean) => void
}): void {
  if (!args.isScrollSettling()) {
    args.complete(true)
    return
  }
  const finish = (): void => {
    if (args.cancelled()) {
      return
    }
    if (args.wasScrollInterrupted()) {
      args.complete(false)
      return
    }
    if (args.isScrollSettling()) {
      args.scheduleFrame(finish)
      return
    }
    // Rows measured along the smooth-scroll path can move its landing position.
    const landed = revealElementInScrollContainer(
      args.container,
      args.element,
      'auto',
      args.markRevealScroll
    )
    args.scheduleFrame(() => {
      if (!args.cancelled()) {
        args.complete(landed && !args.wasScrollInterrupted())
      }
    })
  }
  args.scheduleFrame(finish)
}
