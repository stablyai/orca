import { trackSidebarLiveWidth } from '../../chrome/sidebar-live-width'

const MIN_DOCKED_BOARD_WIDTH = 320
const BOARD_RIGHT_EDGE = '--workspace-board-right-edge'
const PANEL_ZOOM = 'var(--web-panel-zoom, 1)'

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
  // Why: the right edge and 100vw are viewport pixels, but under panel zoom the sheet lays out in local CSS pixels.
  const rightEdge = `var(${BOARD_RIGHT_EDGE}, 100vw) / ${PANEL_ZOOM}`
  const viewport = `100vw / ${PANEL_ZOOM}`
  return `min(max(${rightEdge} - ${drawerLeftCss}, ${MIN_DOCKED_BOARD_WIDTH}px), ${viewport} - ${drawerLeftCss}, 1294px)`
}
