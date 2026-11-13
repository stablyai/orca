import { recordDraft } from '../keyed-record-transitions'

/** Ordered set/delete operations (null deletes); returns `previous` when none changed it. */
export function applyRecordOperations<V>(
  previous: Record<string, V>,
  entries: Iterable<readonly [key: string, value: V | null]>
): Record<string, V> {
  const draft = recordDraft(previous)
  for (const [key, value] of entries) {
    if (value === null) {
      draft.delete(key)
    } else {
      draft.set(key, value)
    }
  }
  return draft.finish()
}
