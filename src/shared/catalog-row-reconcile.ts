import { structuralValuesEqual } from './structural-value-equality'

/**
 * Reuses equal rows from `previous` — and the whole array when nothing moved — so a refetch that
 * changed nothing leaves identity-keyed memos and store subscribers untouched. `getIdentity` must
 * be the key the producing merge already dedups by, so it is unique within `next`.
 */
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
