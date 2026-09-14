import { structuralValuesEqual } from '../../../shared/structural-value-equality'

// Why: returning `base` unchanged keeps referential-equality selectors quiet after no-op catalog refreshes.
export function mergeByIdentity<T>(
  base: readonly T[],
  overlay: readonly T[],
  getIdentity: (entry: T) => string
): readonly T[] {
  const merged = [...base]
  const indexById = new Map(merged.map((entry, index) => [getIdentity(entry), index]))
  let changed = false
  for (const entry of overlay) {
    const identity = getIdentity(entry)
    const index = indexById.get(identity)
    if (index === undefined) {
      indexById.set(identity, merged.length)
      merged.push(entry)
      changed = true
      continue
    }
    if (structuralValuesEqual(merged[index], entry)) {
      continue
    }
    merged[index] = entry
    changed = true
  }
  return changed ? merged : base
}

export function unchangedMergeSource<T>(
  previous: readonly T[],
  preserved: readonly T[],
  merged: readonly T[]
): readonly T[] {
  if (merged === preserved && preserved.length === previous.length) {
    return previous
  }
  return merged
}

export function arrayElementsUnchanged<T>(next: readonly T[], previous: readonly T[]): boolean {
  return (
    next === previous ||
    (next.length === previous.length && next.every((row, index) => row === previous[index]))
  )
}
