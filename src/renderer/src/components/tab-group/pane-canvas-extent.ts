import { PANE_CANVAS_GAP, type PaneCanvasBounds } from './pane-canvas-layout-state'

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
  return terminalTabIds.reduce(
    (extent, terminalTabId) => {
      const bounds = boundsByTerminalTabId[terminalTabId]
      return bounds
        ? {
            width: Math.max(extent.width, bounds.x + bounds.width + PANE_CANVAS_GAP),
            height: Math.max(extent.height, bounds.y + bounds.height + PANE_CANVAS_GAP)
          }
        : extent
    },
    { width: minimumWidth, height: minimumHeight }
  )
}
