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
    const nextItems = next[key]
    const previousItems = previous[key]
    if (previousItems === nextItems) {
      continue
    }
    if (!previousItems || !nextItems || previousItems.length !== nextItems.length) {
      return false
    }
    for (let index = 0; index < nextItems.length; index += 1) {
      const previousItem = previousItems[index]
      const nextItem = nextItems[index]
      if (
        previousItem === undefined ||
        nextItem === undefined ||
        !isSameItem(previousItem, nextItem)
      ) {
        return false
      }
    }
  }
  return true
}
