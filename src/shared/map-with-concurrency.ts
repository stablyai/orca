// Why: bounded-concurrency map. `Promise.all(items.map(fn))` fans out every
// item at once — fine for a handful, but a burst of hundreds of concurrent
// IPC/RPC round-trips can swamp the transport or its call queue. This runs at
// most `limit` calls in flight via a fixed worker pool while preserving input
// order in the result array (results[i] corresponds to items[i]).
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index], index)
      }
    })
  )
  return results
}
