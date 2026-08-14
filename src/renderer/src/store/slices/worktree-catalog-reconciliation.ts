type CatalogRow = { id: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function catalogValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => catalogValuesEqual(value, right[index]))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!catalogValuesEqual(left[key], right[key])) {
      return false
    }
  }
  return true
}

// NOTHING HITS THIS TODAY: both callers key on ids that are unique by
// construction, so buckets stay at 1-3. It only bounds the damage if that ever
// changes — a same-id bucket costs one deep compare per candidate, so an
// unbounded one is O(k^2). A cap beats a second index that would have to stay in
// step with catalogValuesEqual, and reuse is only an optimization: dropping a
// match past the window costs object identity, never correctness.
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
      if (candidate !== undefined && catalogValuesEqual(candidate, row)) {
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
