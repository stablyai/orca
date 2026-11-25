function getHeaderDragNumberAttribute(element: HTMLElement, attribute: string): number | undefined {
  const rawValue = element.getAttribute(attribute)
  if (rawValue === null) {
    return undefined
  }
  const value = Number(rawValue)
  return Number.isFinite(value) ? value : undefined
}

export function measureSidebarHeaderDragRect(
  element: HTMLElement,
  container: HTMLElement,
  containerRect: DOMRect,
  sectionEndAttribute: string
): { top: number; bottom: number; sectionBottom: number | undefined } {
  const zoom = container.currentCSSZoom || 1
  const rect = element.getBoundingClientRect()
  const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
  const virtualRowStart = virtualRow
    ? getHeaderDragNumberAttribute(virtualRow, 'data-worktree-virtual-row-start')
    : undefined
  const top =
    virtualRow && virtualRowStart !== undefined
      ? virtualRowStart + (rect.top - virtualRow.getBoundingClientRect().top) / zoom
      : (rect.top - containerRect.top) / zoom + container.scrollTop
  return {
    top,
    bottom: top + rect.height / zoom,
    sectionBottom: getHeaderDragNumberAttribute(element, sectionEndAttribute)
  }
}
