export type WorktreeSortOrderUpdate = {
  worktreeId: string
  sortOrder: number
}

type WorktreeSortOrderMeta = {
  sortOrder?: number
}

export function planWorktreeSortOrderUpdates(
  orderedIds: readonly string[],
  getMeta: (worktreeId: string) => WorktreeSortOrderMeta | undefined,
  now: number
): WorktreeSortOrderUpdate[] {
  const uniqueIds = [...new Set(orderedIds)]
  const existing = uniqueIds.flatMap((worktreeId) => {
    const meta = getMeta(worktreeId)
    return meta ? [{ worktreeId, sortOrder: meta.sortOrder }] : []
  })
  const alreadyOrdered = existing.every(
    (entry, index) =>
      Number.isFinite(entry.sortOrder) &&
      (index === 0 || existing[index - 1].sortOrder! > entry.sortOrder!)
  )
  if (alreadyOrdered) {
    return []
  }
  return existing.map((entry, index) => ({
    worktreeId: entry.worktreeId,
    sortOrder: now - index * 1000
  }))
}
