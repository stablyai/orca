export type WorktreeSortOrderUpdate = {
  worktreeId: string
  sortOrder: number
}

type WorktreeSortOrderMeta = {
  sortOrder?: number
}

type RankedEntry = {
  worktreeId: string
  sortOrder: number | undefined
}

const RANK_STEP = 1000

export function planWorktreeSortOrderUpdates(
  orderedIds: readonly string[],
  getMeta: (worktreeId: string) => WorktreeSortOrderMeta | undefined,
  now: number
): WorktreeSortOrderUpdate[] {
  const uniqueIds = [...new Set(orderedIds)]
  const existing: RankedEntry[] = uniqueIds.flatMap((worktreeId) => {
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
  // Why: re-ranking every row made one Smart-sort save notify every repo, and a paired client
  // can answer each notice with a whole-host lineage download; re-rank only the rows that moved.
  return planMovedRanks(existing, now) ?? rerankAll(existing, now)
}

function rerankAll(existing: readonly RankedEntry[], now: number): WorktreeSortOrderUpdate[] {
  return existing.map((entry, index) => ({
    worktreeId: entry.worktreeId,
    sortOrder: now - index * RANK_STEP
  }))
}

function planMovedRanks(
  existing: readonly RankedEntry[],
  now: number
): WorktreeSortOrderUpdate[] | null {
  const kept = indicesOfLongestDescendingRun(existing)
  if (kept.size === 0) {
    return null
  }
  const updates: WorktreeSortOrderUpdate[] = []
  let index = 0
  while (index < existing.length) {
    if (kept.has(index)) {
      index += 1
      continue
    }
    const start = index
    while (index < existing.length && !kept.has(index)) {
      index += 1
    }
    const upper = start > 0 ? existing[start - 1].sortOrder : undefined
    const lower = index < existing.length ? existing[index].sortOrder : undefined
    const ranks = ranksBetween(upper, lower, index - start, now)
    if (!ranks) {
      return null
    }
    ranks.forEach((sortOrder, offset) => {
      const entry = existing[start + offset]
      if (entry.sortOrder !== sortOrder) {
        updates.push({ worktreeId: entry.worktreeId, sortOrder })
      }
    })
  }
  return updates
}

/** Rows whose current ranks already descend in list order, as many as possible; they keep their ranks. */
function indicesOfLongestDescendingRun(existing: readonly RankedEntry[]): Set<number> {
  // tails[length - 1] ends the best run of that length: the one whose last rank is highest.
  const tails: number[] = []
  const previous: number[] = Array.from({ length: existing.length }, () => -1)
  existing.forEach((entry, index) => {
    const rank = entry.sortOrder
    if (rank === undefined || !Number.isFinite(rank)) {
      return
    }
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (existing[tails[mid]].sortOrder! > rank) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    previous[index] = low > 0 ? tails[low - 1] : -1
    tails[low] = index
  })
  const kept = new Set<number>()
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]) {
    kept.add(index)
  }
  return kept
}

function ranksBetween(
  upper: number | undefined,
  lower: number | undefined,
  count: number,
  now: number
): number[] | null {
  if (upper === undefined) {
    // Why now: a row moved to the top ranks as a fresh save, as the full re-rank placed it.
    const top = Math.max(now, (lower ?? now) + count * RANK_STEP)
    return Array.from({ length: count }, (_, offset) => top - offset * RANK_STEP)
  }
  if (lower === undefined) {
    return Array.from({ length: count }, (_, offset) => upper - (offset + 1) * RANK_STEP)
  }
  const step = (upper - lower) / (count + 1)
  // Why: ranks stay whole and distinct; a gap too tight for that re-ranks every row instead.
  if (!(step >= 1)) {
    return null
  }
  return Array.from({ length: count }, (_, offset) => upper - Math.round(step * (offset + 1)))
}
