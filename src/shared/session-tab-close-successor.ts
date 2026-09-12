/** Push `tabId` to the tail of the MRU stack (most recently viewed). */
export function rememberRecentTabId(
  recent: readonly string[] | undefined,
  tabId: string
): string[] {
  const base = recent ?? []
  if (base.at(-1) === tabId) {
    return [...base]
  }
  return [...base.filter((id) => id !== tabId), tabId]
}

/**
 * After closing `closingTabId`, pick the next tab id.
 * Prefer the previously viewed tab still in `remainingTabIds` (MRU predecessor).
 * If there is no previous visit, use the most recently added remaining tab
 * (last in strip order), never the leftmost by default.
 */
export function pickNextTabIdAfterClose(args: {
  remainingTabIds: readonly string[]
  closingTabId: string
  recentTabIds?: readonly string[]
}): string | null {
  const remaining = new Set(args.remainingTabIds)
  const recent = args.recentTabIds ?? []
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const id = recent[index]
    if (id !== args.closingTabId && remaining.has(id)) {
      return id
    }
  }
  return args.remainingTabIds.at(-1) ?? null
}

export function pickNextTabAfterClose<T>(
  remaining: readonly T[],
  closingTabId: string,
  recentTabIds?: readonly string[],
  getTabId: (tab: T) => string = (tab) => (tab as { id: string }).id
): T | null {
  const nextId = pickNextTabIdAfterClose({
    remainingTabIds: remaining.map(getTabId),
    closingTabId,
    recentTabIds
  })
  return nextId ? (remaining.find((tab) => getTabId(tab) === nextId) ?? null) : null
}

export function collectRecentTabIdsFromGroups(
  groups: readonly { recentTabIds?: readonly string[] }[] | undefined
): string[] {
  if (!groups || groups.length === 0) {
    return []
  }
  let merged: string[] = []
  for (const group of groups) {
    for (const id of group.recentTabIds ?? []) {
      merged = rememberRecentTabId(merged, id)
    }
  }
  return merged
}
