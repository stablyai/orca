import { readRecordChanges } from './keyed-record-change-reads'

type Buckets<T> = Readonly<Record<string, readonly T[] | undefined>>

function bucketsMatch<T>(
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
 * Whether two tab-bucket maps hold the same workspace keys in the same order and every bucket's
 * rows match index by index. Annotated writes compare only the buckets they replaced.
 */
export function tabBucketsMatch<T>(
  current: Buckets<T> | undefined,
  previous: Buckets<T> | undefined,
  rowsMatch: (current: T, previous: T) => boolean
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
    for (const workspaceId of changes.keys) {
      if (!bucketsMatch(current[workspaceId], previous[workspaceId], rowsMatch)) {
        return false
      }
    }
    return true
  }
  const currentIds = Object.keys(current)
  const previousIds = Object.keys(previous)
  if (currentIds.length !== previousIds.length) {
    return false
  }
  for (let index = 0; index < currentIds.length; index += 1) {
    const workspaceId = currentIds[index]
    if (
      previousIds[index] !== workspaceId ||
      !bucketsMatch(current[workspaceId], previous[workspaceId], rowsMatch)
    ) {
      return false
    }
  }
  return true
}
