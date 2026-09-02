import { PANE_CANVAS_GAP, type PaneCanvasBounds } from './pane-canvas-layout-state'

const PANE_CANVAS_MIN_TRAILING_WORKSPACE = 256
const PANE_CANVAS_TRAILING_VIEWPORT_RATIO = 0.5

export type PaneCanvasViewport = {
  scrollLeft: number
  scrollTop: number
  clientWidth: number
  clientHeight: number
}

export function collectVisiblePaneCanvasTerminalIds(
  terminalTabIds: readonly string[],
  boundsByTerminalTabId: Readonly<Record<string, PaneCanvasBounds>>,
  viewport: PaneCanvasViewport,
  margin: number
): Set<string> {
  const left = Math.max(0, viewport.scrollLeft - margin)
  const top = Math.max(0, viewport.scrollTop - margin)
  const right = viewport.scrollLeft + viewport.clientWidth + margin
  const bottom = viewport.scrollTop + viewport.clientHeight + margin
  const visible = new Set<string>()
  for (const terminalTabId of terminalTabIds) {
    const bounds = boundsByTerminalTabId[terminalTabId]
    if (
      bounds &&
      bounds.x < right &&
      bounds.x + bounds.width > left &&
      bounds.y < bottom &&
      bounds.y + bounds.height > top
    ) {
      visible.add(terminalTabId)
    }
  }
  return visible
}

export function paneCanvasExtent(
  terminalTabIds: readonly string[],
  boundsByTerminalTabId: Readonly<Record<string, PaneCanvasBounds>>,
  minimumWidth: number,
  minimumHeight: number
): { width: number; height: number } {
  const trailingWidth = Math.max(
    PANE_CANVAS_MIN_TRAILING_WORKSPACE,
    minimumWidth * PANE_CANVAS_TRAILING_VIEWPORT_RATIO
  )
  const trailingHeight = Math.max(
    PANE_CANVAS_MIN_TRAILING_WORKSPACE,
    minimumHeight * PANE_CANVAS_TRAILING_VIEWPORT_RATIO
  )
  return terminalTabIds.reduce(
    (extent, terminalTabId) => {
      const bounds = boundsByTerminalTabId[terminalTabId]
      return bounds
        ? {
            // Keep useful blank workspace beyond the last card. Without it a
            // viewport-height terminal puts its resize edge at the scroll
            // boundary, so there is nowhere to pan before extending it.
            width: Math.max(
              extent.width,
              bounds.x + bounds.width + PANE_CANVAS_GAP + trailingWidth
            ),
            height: Math.max(
              extent.height,
              bounds.y + bounds.height + PANE_CANVAS_GAP + trailingHeight
            )
          }
        : extent
    },
    { width: minimumWidth, height: minimumHeight }
  )
}
