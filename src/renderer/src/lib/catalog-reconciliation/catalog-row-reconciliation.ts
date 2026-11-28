import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/collections/structural-value-equality'

type CatalogRow = { id: string }

// Cap duplicate-ID scans to avoid O(k²) growth if normally tiny buckets expand; missed reuse loses identity only, so no second structural index is needed.
const MAX_DUPLICATE_ID_SCAN = 8

export function reuseEqualCatalogRows<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): T[] {
  if (!current) {
    return [...incoming]
  }
  const singleById = new Map<string, T>()
  let duplicatesById: Map<string, T[]> | undefined
  for (const row of current) {
    const duplicates = duplicatesById?.get(row.id)
    if (duplicates) {
      duplicates.push(row)
      continue
    }
    const existing = singleById.get(row.id)
    if (existing !== undefined) {
      singleById.delete(row.id)
      duplicatesById ??= new Map()
      duplicatesById.set(row.id, [existing, row])
    } else {
      singleById.set(row.id, row)
    }
  }
  let allSame = current.length === incoming.length
  const reconciled: T[] = []
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i]
    let matched: T = row
    const single = singleById.get(row.id)
    if (single !== undefined) {
      if (structuralValuesEqualIgnoringUndefined(single, row)) {
        singleById.delete(row.id)
        matched = single
      }
    } else {
      const candidates = duplicatesById?.get(row.id)
      if (candidates) {
        const scanLimit = Math.min(candidates.length, MAX_DUPLICATE_ID_SCAN)
        for (let index = 0; index < scanLimit; index++) {
          const candidate = candidates[index]
          if (candidate !== undefined && structuralValuesEqualIgnoringUndefined(candidate, row)) {
            candidates.splice(index, 1)
            matched = candidate
            break
          }
        }
      }
    }
    reconciled.push(matched)
    if (allSame && current[i] !== matched) {
      allSame = false
    }
  }
  return allSame ? (current as T[]) : reconciled
}

export function catalogRowsEqual<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): boolean {
  if (current === incoming) {
    return true
  }
  if (!current || current.length !== incoming.length) {
    return false
  }
  for (let index = 0; index < current.length; index++) {
    const row = current[index]
    const next = incoming[index]
    if (
      row !== next &&
      (row.id !== next.id || !structuralValuesEqualIgnoringUndefined(row, next))
    ) {
      return false
    }
  }
  return true
}
