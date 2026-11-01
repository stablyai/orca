/** Round-robin hosts under row caps so contiguous late SSH repos cannot disappear (#18104).
 * Keep selected rows in original relative order; uncapped listings pass through unchanged. */
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
  // Retain buckets longer than round in first-appearance order; write at or before the read cursor.
  // Retiring exhausted buckets avoids rescanning them for every row of a long host bucket.
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
