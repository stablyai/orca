import { recordDraft } from '../../../keyed-record-transitions'

/** Preserve identity when no key matches or teardown rerenders selectors for dozens of unchanged maps. Nullish partial-test slices normalize to {}, matching spread/delete; production initializes them. */
export function omitRecordKeys<T>(
  record: Record<string, T> | undefined,
  keys: Iterable<string>
): Record<string, T> {
  if (!record) {
    return {}
  }
  const draft = recordDraft(record)
  for (const key of keys) {
    draft.delete(key)
  }
  return draft.finish()
}
