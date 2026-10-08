export type SessionTabPlacementOptions = {
  afterParentGroup?: boolean
}

/** Places a created tab after the anchor, or after its parent group when enabled. */
export function placeCreatedSessionTab<T extends { id: string; parentTabId?: string }>(
  tabs: readonly T[],
  created: T,
  afterTabId: string | null | undefined,
  options: SessionTabPlacementOptions = {}
): T[] {
  const next = tabs.filter((tab) => tab.id !== created.id)
  const anchor = afterTabId ? next.findIndex((tab) => tab.id === afterTabId) : -1
  if (anchor < 0) {
    next.push(created)
    return next
  }
  let insertAfter = anchor
  const anchorParentTabId = next[anchor].parentTabId
  if (options.afterParentGroup && anchorParentTabId) {
    for (let index = anchor + 1; index < next.length; index += 1) {
      if (next[index].parentTabId === anchorParentTabId) {
        insertAfter = index
      }
    }
  }
  next.splice(insertAfter + 1, 0, created)
  return next
}
