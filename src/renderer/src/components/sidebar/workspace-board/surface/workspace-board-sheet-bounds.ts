import { trackSidebarLiveWidth } from '../../chrome/sidebar-live-width'

const MIN_DOCKED_BOARD_WIDTH = 320
const BOARD_RIGHT_EDGE = '--workspace-board-right-edge'

/** Board sheets start at the workspace sidebar; this tracks where the center column ends. */
export function trackWorkspaceBoardBounds(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return
  }

  const stopTrackingSidebar = trackSidebarLiveWidth(element)
  const workspace = element.ownerDocument.querySelector('[data-workspace-shell-content]')
  if (!workspace) {
    return stopTrackingSidebar
  }

  let lastRightEdge: string | null = null
  // Why: ResizeObserver's initial delivery runs before first paint, so no synchronous sync is needed.
  const observer = new ResizeObserver(() => {
    const next = `${workspace.getBoundingClientRect().right}px`
    if (next === lastRightEdge) {
      return
    }
    lastRightEdge = next
    element.style.setProperty(BOARD_RIGHT_EDGE, next)
  })
  observer.observe(workspace)
  return () => {
    observer.disconnect()
    stopTrackingSidebar?.()
  }
}

/** Ends the sheet at the tracked right edge; without it the width falls back to the viewport. */
export function workspaceBoardSheetWidth(drawerLeftCss: string): string {
  return `min(max(var(${BOARD_RIGHT_EDGE}, 100vw) - ${drawerLeftCss}, ${MIN_DOCKED_BOARD_WIDTH}px), 100vw - ${drawerLeftCss}, 1294px)`
}
