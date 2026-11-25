/** Translate viewport pixels to the sidebar's logical scroll coordinates. */
export function sidebarContentY(
  container: HTMLElement,
  clientY: number,
  viewportTop = container.getBoundingClientRect().top
): number {
  return (clientY - viewportTop) / (container.currentCSSZoom || 1) + container.scrollTop
}
