import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'

type CatalogRow = { id: string }

// Above this many rows sharing an id, matching switches from a linear scan to a
// fingerprint index: scanning costs one deep compare per candidate, so an
// unbounded bucket would be O(k^2). Below it the scan is cheaper than building
// an index, and that is where every live caller sits — both key on ids that are
// unique by construction, so buckets stay at 1-3.
const DUPLICATE_ID_INDEX_THRESHOLD = 8

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
  // Stays null unless some id actually exceeds the threshold, so the live path
  // allocates exactly what it did before — one array per id and nothing else.
  let indexesById: Map<string, Map<string, T[]> | null> | null = null
  const reconciled = incoming.map((row) => {
    const candidates = currentById.get(row.id)
    if (candidates === undefined) {
      return row
    }
    const existing = indexesById?.get(row.id)
    // A bucket only shrinks, so once it is under the threshold with no index it
    // stays on the scan, and the two strategies never both consume from it.
    if (existing === undefined && candidates.length <= DUPLICATE_ID_INDEX_THRESHOLD) {
      return spliceEqualRow(candidates, row, candidates.length) ?? row
    }
    let index = existing
    if (index === undefined) {
      index = buildFingerprintIndex(candidates)
      indexesById ??= new Map()
      indexesById.set(row.id, index)
    }
    if (index === null) {
      // JSON.stringify rejects some values the equality walk handles fine
      // (BigInt); those fall back to a capped scan so O(k^2) cannot return here.
      return spliceEqualRow(candidates, row, DUPLICATE_ID_INDEX_THRESHOLD) ?? row
    }
    // Consumes at most one previous row, so two duplicates cannot both reuse it.
    const matches = index.get(catalogRowFingerprint(row) ?? '')
    while (matches !== undefined && matches.length > 0) {
      const candidate = matches.shift()
      if (candidate !== undefined && structuralValuesEqualIgnoringUndefined(candidate, row)) {
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

function spliceEqualRow<T>(rows: T[], row: T, scanLimit: number): T | null {
  const limit = Math.min(rows.length, scanLimit)
  for (let index = 0; index < limit; index++) {
    const candidate = rows[index]
    if (candidate !== undefined && structuralValuesEqualIgnoringUndefined(candidate, row)) {
      rows.splice(index, 1)
      return candidate
    }
  }
  return null
}

function buildFingerprintIndex<T>(rows: readonly T[]): Map<string, T[]> | null {
  const index = new Map<string, T[]>()
  for (const row of rows) {
    const key = catalogRowFingerprint(row)
    if (key === null) {
      return null
    }
    const existing = index.get(key)
    if (existing) {
      existing.push(row)
    } else {
      index.set(key, [row])
    }
  }
  return index
}

// Only a pre-filter — every hit is confirmed with the real equality walk before
// it is reused. That is what stops this being a second equality implementation
// to hold in step with structuralValuesEqualIgnoringUndefined: if the two ever
// disagree the cost is a missed reuse (one fresh object identity), never a wrong
// row. Keys are sorted because property order is not significant, and JSON drops
// undefined-valued keys, which is the ignoring-undefined semantics.
function catalogRowFingerprint(row: unknown): string | null {
  try {
    return (
      JSON.stringify(row, (_key, value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0
              )
            )
          : value
      ) ?? 'undefined'
    )
  } catch {
    return null
  }
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
