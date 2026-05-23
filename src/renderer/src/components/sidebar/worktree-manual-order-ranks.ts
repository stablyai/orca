export type WorktreeManualOrderUpdate = {
  manualOrder: number
}

const MANUAL_ORDER_STRIDE = 1000

function buildFallbackManualOrderUpdates(
  orderedIds: readonly string[],
  now: number
): Map<string, WorktreeManualOrderUpdate> {
  const updates = new Map<string, WorktreeManualOrderUpdate>()
  for (let index = 0; index < orderedIds.length; index++) {
    updates.set(orderedIds[index]!, { manualOrder: now - index * MANUAL_ORDER_STRIDE })
  }
  return updates
}

function getManualOrderRank(
  rankByWorktreeId: ReadonlyMap<string, number>,
  worktreeId: string | undefined
): number | null {
  if (!worktreeId) {
    return null
  }
  const rank = rankByWorktreeId.get(worktreeId)
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : null
}

export function buildSparseManualOrderUpdates(args: {
  orderedIds: readonly string[]
  movedIds: readonly string[]
  rankByWorktreeId?: ReadonlyMap<string, number>
  now: number
}): Map<string, WorktreeManualOrderUpdate> {
  const movedSet = new Set(args.movedIds)
  const orderedMovedIds = args.orderedIds.filter((id) => movedSet.has(id))
  if (orderedMovedIds.length === 0) {
    return new Map()
  }
  if (!args.rankByWorktreeId) {
    return buildFallbackManualOrderUpdates(args.orderedIds, args.now)
  }

  const firstMovedIndex = args.orderedIds.findIndex((id) => movedSet.has(id))
  const lastMovedIndex = args.orderedIds.findLastIndex((id) => movedSet.has(id))
  const beforeId = args.orderedIds.slice(0, firstMovedIndex).findLast((id) => !movedSet.has(id))
  const afterId = args.orderedIds.slice(lastMovedIndex + 1).find((id) => !movedSet.has(id))
  const beforeRank = getManualOrderRank(args.rankByWorktreeId, beforeId)
  const afterRank = getManualOrderRank(args.rankByWorktreeId, afterId)
  const nextRanks: number[] = []

  if (beforeId !== undefined && beforeRank === null) {
    return buildFallbackManualOrderUpdates(args.orderedIds, args.now)
  }
  if (afterId !== undefined && afterRank === null) {
    return buildFallbackManualOrderUpdates(args.orderedIds, args.now)
  }

  if (beforeRank === null && afterRank === null) {
    for (let index = 0; index < orderedMovedIds.length; index++) {
      nextRanks.push(args.now - index * MANUAL_ORDER_STRIDE)
    }
  } else if (beforeRank === null) {
    const start = Math.max(args.now, afterRank! + orderedMovedIds.length * MANUAL_ORDER_STRIDE)
    for (let index = 0; index < orderedMovedIds.length; index++) {
      nextRanks.push(start - index * MANUAL_ORDER_STRIDE)
    }
  } else if (afterRank === null) {
    for (let index = 0; index < orderedMovedIds.length; index++) {
      nextRanks.push(beforeRank - (index + 1) * MANUAL_ORDER_STRIDE)
    }
  } else {
    const gap = beforeRank - afterRank
    // Why: repeated sparse inserts can eventually exhaust the numeric gap.
    // Re-index only in that rare dense case; ordinary drags persist moved rows.
    if (gap <= orderedMovedIds.length) {
      return buildFallbackManualOrderUpdates(args.orderedIds, args.now)
    }
    const step = gap / (orderedMovedIds.length + 1)
    for (let index = 0; index < orderedMovedIds.length; index++) {
      nextRanks.push(beforeRank - step * (index + 1))
    }
  }

  const updates = new Map<string, WorktreeManualOrderUpdate>()
  orderedMovedIds.forEach((id, index) => {
    const manualOrder = nextRanks[index]
    if (manualOrder !== undefined && Number.isFinite(manualOrder)) {
      updates.set(id, { manualOrder })
    }
  })
  return updates
}
