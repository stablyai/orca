/**
 * Identity-first equality over two arrays under a projection of each item: the same array, or the
 * same length with every item pair accepted by `isSameItem`. A missing side or a hole is unequal.
 */
export function sameProjectedItems<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  isSameItem: (previous: T, next: T) => boolean
): boolean {
  if (previous === next) {
    return true
  }
  if (!previous || !next || previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index += 1) {
    const previousItem = previous[index]
    const nextItem = next[index]
    if (
      previousItem === undefined ||
      nextItem === undefined ||
      !isSameItem(previousItem, nextItem)
    ) {
      return false
    }
  }
  return true
}

/**
 * Identity-first equality over a `Record<string, readonly T[]>` under a projection of each item.
 *
 * Why not `createWorktreeTabBucketProjection`: that builds a projected record so callers can hold
 * it; a subscriber that only needs "did my fields change?" pays for an allocation per store write.
 * This answers the same question by comparing in place.
 */
export function sameBucketRecords<T>(
  previous: Readonly<Record<string, readonly T[]>>,
  next: Readonly<Record<string, readonly T[]>>,
  isSameItem: (previous: T, next: T) => boolean
): boolean {
  if (previous === next) {
    return true
  }
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(previous).length) {
    return false
  }
  for (const key of keys) {
    if (!sameProjectedItems(previous[key], next[key], isSameItem)) {
      return false
    }
  }
  return true
}
