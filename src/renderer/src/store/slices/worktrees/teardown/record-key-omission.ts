/**
 * Key removal that keeps a record's identity when it had none of the keys.
 *
 * Why identity matters here: teardown rewrites dozens of store maps at once, and
 * a removed worktree has an entry in only a few of them. Copying the rest anyway
 * gives every one a new reference, which rerenders every component selecting it
 * for no data change.
 *
 * Why nullish input yields `{}`: some worktree-isolation callers hand over states
 * with a slice omitted, and the spread-then-delete this replaces normalized those
 * to an empty record. Production always initialises them, so the fresh object here
 * costs nothing at runtime.
 */
export function omitRecordKeys<T>(
  record: Record<string, T> | undefined,
  keys: Iterable<string>
): Record<string, T> {
  if (!record) {
    return {}
  }
  let next: Record<string, T> | null = null
  for (const key of keys) {
    if (!(key in record)) {
      continue
    }
    next ??= { ...record }
    delete next[key]
  }
  return next ?? record
}
