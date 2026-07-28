// Why: large IPC/RPC collections must not start every operation at once.
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const workerCount = concurrencyWorkerCount(limit, items.length)
  if (items.length <= workerCount) {
    return Promise.all(items.map(fn))
  }

  const results: R[] = []
  let nextIndex = 0
  return Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index], index)
      }
    })
  ).then(() => results)
}

export function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  const workerCount = concurrencyWorkerCount(limit, items.length)
  if (items.length <= workerCount) {
    return Promise.all(items.map(fn)).then(() => undefined)
  }

  let nextIndex = 0
  return Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        await fn(items[index], index)
      }
    })
  ).then(() => undefined)
}

function concurrencyWorkerCount(limit: number, itemCount: number): number {
  const normalizedLimit =
    limit === Number.POSITIVE_INFINITY ? itemCount : Number.isFinite(limit) ? Math.floor(limit) : 1
  return Math.max(1, Math.min(normalizedLimit, itemCount))
}
