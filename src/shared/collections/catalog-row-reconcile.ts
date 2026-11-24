import { structuralValuesEqual } from './structural-value-equality'

/** Reuse equal rows/unchanged arrays to preserve memo/subscriber identity; getIdentity must be unique in next and match the producing merge’s dedupe key. */
export function reconcileCatalogRows<T>(
  previous: readonly T[],
  next: readonly T[],
  getIdentity: (row: T) => string
): readonly T[] {
  const previousByIdentity = new Map(previous.map((row) => [getIdentity(row), row]))
  let identical = next.length === previous.length
  const reconciled = next.map((row, index) => {
    const existing = previousByIdentity.get(getIdentity(row))
    if (existing !== undefined && structuralValuesEqual(existing, row)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return row
  })
  return identical ? previous : reconciled
}
