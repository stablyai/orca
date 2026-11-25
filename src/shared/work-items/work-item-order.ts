// Main rows lack renderer-stamped repoId; require only number and sort newest-first like GitHub Issues.
export function sortWorkItemsByNumber<T extends { number: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.number - left.number)
}

type WorkItemOrderFields = {
  number: number
  createdAt?: string
  repoId: string
  repoHostId?: string
}

// Numbers only compare within one repo, so rows from several repos merge newest-created first;
// if any row lacks createdAt (older hosts), the whole list keeps number order.
export function sortWorkItemsByRecency<T>(
  items: readonly T[],
  fields: (item: T) => WorkItemOrderFields
): T[] {
  const keys = items.map(fields)
  const crossRepo = keys.some(
    (key) => key.repoId !== keys[0].repoId || key.repoHostId !== keys[0].repoHostId
  )
  const created = crossRepo ? keys.map((key) => Date.parse(key.createdAt ?? '')) : []
  const byCreated = crossRepo && !created.some(Number.isNaN)
  return keys
    .map((_, index) => index)
    .sort(
      (left, right) =>
        (byCreated ? created[right] - created[left] : 0) || keys[right].number - keys[left].number
    )
    .map((index) => items[index])
}
