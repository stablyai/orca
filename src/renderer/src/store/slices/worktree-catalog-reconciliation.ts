import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'

type CatalogRow = { id: string }

// NOTHING HITS THIS TODAY: both callers key on ids that are unique by
// construction, so buckets stay at 1-3. It only bounds the damage if that ever
// changes — a same-id bucket costs one deep compare per candidate, so an
// unbounded one is O(k^2). A cap beats an index keyed on a second walk that
// would have to stay in step with structuralValuesEqualIgnoringUndefined, and
// reuse is only an optimization: dropping a match past the window costs object
// identity, never correctness.
const MAX_DUPLICATE_ID_SCAN = 8

export function reuseEqualCatalogRows<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): T[] {
  if (!current) {
    return [...incoming]
  }
  const currentById = new Map<string, T[]>()
  for (const row of current) {
    const candidates = currentById.get(row.id)
    if (candidates) {
      candidates.push(row)
    } else {
      currentById.set(row.id, [row])
    }
  }
  const reconciled = incoming.map((row) => {
    const candidates = currentById.get(row.id)
    if (!candidates) {
      return row
    }
    const scanLimit = Math.min(candidates.length, MAX_DUPLICATE_ID_SCAN)
    for (let index = 0; index < scanLimit; index++) {
      const candidate = candidates[index]
      if (candidate !== undefined && structuralValuesEqualIgnoringUndefined(candidate, row)) {
        candidates.splice(index, 1)
        return candidate
      }
    }
    return row
  })
  return current.length === reconciled.length &&
    current.every((row, index) => row === reconciled[index])
    ? (current as T[])
    : reconciled
}

export function catalogRowsEqual<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): boolean {
  if (current === incoming) {
    return true
  }
  return reuseEqualCatalogRows(current, incoming) === current
}
