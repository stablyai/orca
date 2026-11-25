// Only the extra width from zooming the list is capped; a saved width still fits exactly as before.
export function scaledSidebarWidthCss(logicalWidth: string): string {
  return `min(${logicalWidth} * var(--sidebar-zoom-ratio, 1), max(${logicalWidth}, 50vw / var(--web-panel-zoom, 1)))`
}

/** Where a drawer that opens beside the workspace list starts: right of the app rail and, when open, the list. */
export function resolveSidebarDrawerLeftEdge({
  sidebarOpen,
  sidebarWidth,
  railWidth
}: {
  sidebarOpen: boolean
  sidebarWidth: number
  railWidth: number
}): { left: number; leftCss: string } {
  const listLeftCss = scaledSidebarWidthCss(
    `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
  )
  if (!sidebarOpen) {
    return { left: railWidth, leftCss: `${railWidth}px` }
  }
  return {
    left: railWidth + sidebarWidth,
    leftCss: `calc(${railWidth}px + ${listLeftCss})`
  }
}
