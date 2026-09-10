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
  const chosen: number[] = []
  // Compacting in place keeps `buckets[0..activeCount)` as exactly the buckets longer than
  // `round`, in their original order, so `bucket[round]` is always defined and the round robin
  // still visits hosts in first-appearance order. Retiring them keeps a long host bucket from
  // re-scanning every exhausted one. Writes land at or before the slot just read, never ahead.
  let activeCount = buckets.length
  let round = 0
  while (chosen.length < limit && activeCount > 0) {
    let nextActiveCount = 0
    for (
      let bucketIndex = 0;
      bucketIndex < activeCount && chosen.length < limit;
      bucketIndex += 1
    ) {
      const bucket = buckets[bucketIndex]
      chosen.push(bucket[round])
      if (bucket.length > round + 1) {
        buckets[nextActiveCount] = bucket
        nextActiveCount += 1
      }
    }
    activeCount = nextActiveCount
    round += 1
  }
  return chosen.sort((left, right) => left - right).map((index) => rows[index] as TRow)
}
