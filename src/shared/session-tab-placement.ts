/**
 * Where a newly created session tab lands in a tab list.
 *
 * Shared because a client that optimistically paints a created tab and the host that publishes
 * the authoritative snapshot must agree. When they disagreed — the client appending while the
 * host spliced after `afterTabId` — the new tab painted at the end and then visibly jumped to its
 * real slot as soon as the host frame landed.
 */
export function placeCreatedSessionTab<T extends { id: string }>(
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
  next.splice(anchor + 1, 0, created)
  return next
}
