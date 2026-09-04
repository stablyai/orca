// Why never filtered against live tabs: UI hydrates before the tab catalogs (the
// `filterRepoIds` trap) and the list is shared across clients, so no one client's
// tabs are authoritative. Stale ids are simply never read by the grid's index map.

/** Drop duplicates, keeping the first occurrence. Returns the input when already clean. */
export function sanitizeSessionGridTabOrder(order: readonly string[] | undefined): string[] {
  if (!order || order.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const clean: string[] = []
  for (const id of order) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      clean.push(id)
    }
  }
  // Returning the input when nothing was dropped is redundancy, not a guard: the only caller
  // (hydrateSessionGridState) re-checks identity against the STORE's array right after, and the
  // persisted writer never sees this output — it diffs by value in `stringArrayEqual`.
  return clean.length === order.length ? (order as string[]) : clean
}

/** Remove one retired tab. Returns the input when the id was not present. */
export function pruneSessionGridTabOrder(order: readonly string[], closedTabId: string): string[] {
  return order.includes(closedTabId)
    ? order.filter((id) => id !== closedTabId)
    : (order as string[])
}

/**
 * The global order after dropping `activeTabId` onto `overTabId`, computed over
 * the FULL live list rather than the filtered view. Under a workspace filter
 * the dragged card lands at the global index of the card it was dropped on
 * and every other card keeps its relative position; under no filter this is
 * plain `arrayMove`. Because the input is the live list, stale ids fall out.
 */
export function buildSessionGridDragOrder(
  liveOrderedTabIds: readonly string[],
  activeTabId: string,
  overTabId: string
): string[] | null {
  const from = liveOrderedTabIds.indexOf(activeTabId)
  const to = liveOrderedTabIds.indexOf(overTabId)
  if (from === -1 || to === -1 || from === to) {
    return null
  }
  const next = [...liveOrderedTabIds]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
