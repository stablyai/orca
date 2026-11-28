import { trackSidebarLiveWidth } from '../../chrome/sidebar-live-width'

const MIN_DOCKED_BOARD_WIDTH = 320
const BOARD_RIGHT_EDGE = '--workspace-board-right-edge'

/** Board sheets start at the workspace sidebar; this tracks where the center column ends. */
export function trackWorkspaceBoardBounds(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return
  }

  const stopTrackingSidebar = trackSidebarLiveWidth(element)
  const document = element.ownerDocument
  let lastRightEdge: string | null = null
  let observedWorkspace: Element | null = null
  const updateRightEdge = (): void => {
    const workspace = document.querySelector('[data-workspace-shell-content]')
    if (!workspace) {
      return
    }
    if (workspace !== observedWorkspace) {
      observer.disconnect()
      observer.observe(workspace)
      observedWorkspace = workspace
    }
    const next = `${workspace.getBoundingClientRect().right}px`
    if (next === lastRightEdge) {
      return
    }
    lastRightEdge = next
    element.style.setProperty(BOARD_RIGHT_EDGE, next)
  }
  const observer = new ResizeObserver(updateRightEdge)
  const window = document.defaultView
  window?.addEventListener('resize', updateRightEdge)
  updateRightEdge()
  return () => {
    observer.disconnect()
    window?.removeEventListener('resize', updateRightEdge)
    stopTrackingSidebar?.()
  }
}

/** Ends the sheet at the tracked right edge; without it the width falls back to the viewport. */
export function workspaceBoardSheetWidth(drawerLeftCss: string, expand = false): string {
  const maxWidth = expand ? '100vw' : '1294px'
  return `min(max(var(${BOARD_RIGHT_EDGE}, 100vw) - ${drawerLeftCss}, ${MIN_DOCKED_BOARD_WIDTH}px), 100vw - ${drawerLeftCss}, ${maxWidth})`
}
