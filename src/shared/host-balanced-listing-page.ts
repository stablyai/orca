/**
 * Chooses which rows survive a listing's row cap so that no execution host is starved by it.
 *
 * Worktree rows are resolved repo by repo, so every SSH repo's rows land contiguously at the end
 * of the fleet order — 24 remote worktrees sat at indices 496-520 of 521 and a 200-row cap
 * returned zero of them (#18104). A per-host round robin gives each host a share of the cap.
 *
 * Chosen rows keep the caller's original relative order, so the page stays a subsequence of the
 * unbounded listing and nothing downstream has to re-sort. An uncapped listing is returned as-is.
 */
export function selectHostBalancedPage<TRow>(
  rows: readonly TRow[],
  limit: number,
  getHostId: (row: TRow) => string | null | undefined
): TRow[] {
  if (rows.length <= limit) {
    return [...rows]
  }
  // Insertion order is first-appearance order per host, so the round robin is deterministic.
  const indicesByHost = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const hostId = getHostId(row) ?? ''
    const bucket = indicesByHost.get(hostId)
    if (bucket) {
      bucket.push(index)
    } else {
      indicesByHost.set(hostId, [index])
    }
  })
  const buckets = [...indicesByHost.values()]
  const cursors = buckets.map(() => 0)
  const chosen: number[] = []
  while (chosen.length < limit) {
    let advanced = false
    for (let bucket = 0; bucket < buckets.length && chosen.length < limit; bucket += 1) {
      const cursor = cursors[bucket] ?? 0
      const index = buckets[bucket]?.[cursor]
      if (index !== undefined) {
        chosen.push(index)
        cursors[bucket] = cursor + 1
        advanced = true
      }
    }
    if (!advanced) {
      break
    }
  }
  return chosen.sort((left, right) => left - right).map((index) => rows[index] as TRow)
}
