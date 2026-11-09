import { annotateRecordReplacement } from '../../../keyed-record-transitions'

/** Preserve identity when no key matches or teardown rerenders selectors for dozens of unchanged maps. Nullish partial-test slices normalize to {}, matching spread/delete; production initializes them. */
export function omitRecordKeys<T>(
  record: Record<string, T> | undefined,
  keys: Iterable<string>
): Record<string, T> {
  if (!record) {
    return {}
  }
  let next: Record<string, T> | null = null
  const omitted: string[] = []
  for (const key of keys) {
    if (!(key in record)) {
      continue
    }
    next ??= { ...record }
    delete next[key]
    omitted.push(key)
  }
  return next ? annotateRecordReplacement(record, next, omitted) : record
}
