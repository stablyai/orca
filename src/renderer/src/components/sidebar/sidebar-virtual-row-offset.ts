/** Resolve a virtualized sidebar row's absolute top from its
 *  data-worktree-virtual-row-start attribute; null when unset/invalid. */
function getVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  // Reject empty too: Number('') is 0, which would snap hit-testing to the top.
  if (rawStart === null || rawStart.trim() === '') {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

/** The logical slot top (container coords) of an element's virtual row,
 *  excluding intra-row spacing. Matches the virtualizer item.start the
 *  gap-opening shift keys off, so drop boundaries align with it; null when the
 *  element is not inside a measured virtual row. */
export function resolveVirtualRowStart(element: HTMLElement): number | null {
  return getVirtualRowStart(element.closest<HTMLElement>('[data-worktree-virtual-row]'))
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
