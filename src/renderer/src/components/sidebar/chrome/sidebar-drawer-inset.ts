/** The app rail contributes to the inset only when it shares the workspace list’s edge. */
export function resolveSidebarDrawerInset({
  sidebarOpen,
  sidebarWidth,
  railWidth
}: {
  sidebarOpen: boolean
  sidebarWidth: number
  railWidth: number
}): { inset: number; insetCss: string } {
  const listInsetCss = `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
  if (!sidebarOpen) {
    return { inset: railWidth, insetCss: `${railWidth}px` }
  }
  return {
    inset: railWidth + sidebarWidth,
    insetCss: railWidth > 0 ? `calc(${railWidth}px + ${listInsetCss})` : listInsetCss
  }
}
