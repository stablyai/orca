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
  const listLeftCss = `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
  if (!sidebarOpen) {
    return { left: railWidth, leftCss: `${railWidth}px` }
  }
  return {
    left: railWidth + sidebarWidth,
    leftCss: railWidth > 0 ? `calc(${railWidth}px + ${listLeftCss})` : listLeftCss
  }
}
