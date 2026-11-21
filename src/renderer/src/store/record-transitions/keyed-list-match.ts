import { readRecordChanges } from './keyed-record-change-reads'

type KeyedLists<T> = Readonly<Record<string, readonly T[] | undefined>>

function listsMatch<T>(
  current: readonly T[] | undefined,
  previous: readonly T[] | undefined,
  rowsMatch: (current: T, previous: T) => boolean
): boolean {
  if (current === previous) {
    return true
  }
  if (!current || !previous || current.length !== previous.length) {
    return false
  }
  for (let index = 0; index < current.length; index += 1) {
    if (!rowsMatch(current[index], previous[index])) {
      return false
    }
  }
  return true
}

/**
 * Whether two keyed records of lists (tab buckets, pty ids by tab) hold the same keys (in the same
 * order unless `keyOrder` is 'any') and every list matches index by index. Annotated writes compare
 * only the lists they replaced; they never reorder surviving keys.
 */
export function keyedListsMatch<T>(
  current: KeyedLists<T> | undefined,
  previous: KeyedLists<T> | undefined,
  rowsMatch: (current: T, previous: T) => boolean,
  /** 'any' matches by key, as a reader that never depends on workspace order would. */
  keyOrder: 'ordered' | 'any' = 'ordered'
): boolean {
  if (current === previous) {
    return true
  }
  if (!current || !previous) {
    return false
  }
  const changes = readRecordChanges(current, previous)
  if (!changes) {
    return true
  }
  if (changes.kind === 'addressed') {
    if (changes.added.length > 0 || changes.deleted.size > 0) {
      return false
    }
    for (const key of changes.keys) {
      if (!listsMatch(current[key], previous[key], rowsMatch)) {
        return false
      }
    }
    return true
  }
  const currentKeys = Object.keys(current)
  const previousKeys = Object.keys(previous)
  if (currentKeys.length !== previousKeys.length) {
    return false
  }
  for (let index = 0; index < currentKeys.length; index += 1) {
    const key = currentKeys[index]
    if (
      (keyOrder === 'ordered' ? previousKeys[index] !== key : !Object.hasOwn(previous, key)) ||
      !listsMatch(current[key], previous[key], rowsMatch)
    ) {
      return false
    }
  }
  return true
}
