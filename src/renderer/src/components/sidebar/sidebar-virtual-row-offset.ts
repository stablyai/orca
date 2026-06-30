/** Resolve a virtualized sidebar row's absolute top from its
 *  data-worktree-virtual-row-start attribute; null when unset/invalid. */
function getVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  if (rawStart === null) {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

/**
 * Resolve an element's top position relative to its scroll container, handling
 * virtual rows whose CSS transforms would otherwise skew the coordinate.
 * Why: sticky-pinned virtual rows shift their children's getBoundingClientRect
 * without changing the logical slot — anchoring to virtualRowStart corrects for
 * the transform offset so drag/drop hit-testing stays frame-accurate.
 */
export function resolveVirtualRowTop(
  element: HTMLElement,
  container: HTMLElement,
  containerRect: DOMRect
): number {
  const rect = element.getBoundingClientRect()
  const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
  const virtualRowStart = getVirtualRowStart(virtualRow)
  return virtualRow && virtualRowStart !== null
    ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
    : rect.top - containerRect.top + container.scrollTop
}
