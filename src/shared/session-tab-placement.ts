/** Places a created tab after the anchor's top-level terminal group, or appends when unanchored. */
export function placeCreatedSessionTab<T extends { id: string; parentTabId?: string }>(
  tabs: readonly T[],
  created: T,
  afterTabId: string | null | undefined
): T[] {
  const next = tabs.filter((tab) => tab.id !== created.id)
  const anchor = afterTabId ? next.findIndex((tab) => tab.id === afterTabId) : -1
  if (anchor < 0) {
    next.push(created)
    return next
  }
  let insertAfter = anchor
  const anchorParentTabId = next[anchor].parentTabId
  if (anchorParentTabId) {
    while (
      insertAfter + 1 < next.length &&
      next[insertAfter + 1].parentTabId === anchorParentTabId
    ) {
      insertAfter += 1
    }
  }
  next.splice(insertAfter + 1, 0, created)
  return next
}
