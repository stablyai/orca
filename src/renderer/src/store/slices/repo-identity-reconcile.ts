import type { Repo } from '../../../../shared/repo-types'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { getRepoHostIdentity } from './repo-host-identity'
import { reconcileCatalogRows } from '../../../../shared/catalog-row-reconcile'

// Reuse structurally equal rows/arrays on IPC echoes after drag reorder or virtualizer memos rebuild and visibly jump. Reference equality cannot compare main-rebuilt/cloned nested Repo fields.

export function reconcileFetchedRepos(
  previous: readonly Repo[],
  next: readonly Repo[]
): readonly Repo[] {
  return reconcileCatalogRows(previous, next, getRepoHostIdentity)
}

/**
 * Reuses equal record values from `previous` — and the whole map when nothing
 * changed — so a cloned no-op refresh leaves Object.is subscribers untouched.
 */
export function reuseEqualRecordMap<T>(
  previous: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>
): Readonly<Record<string, T>> {
  const nextKeys = Object.keys(next)
  // Equal count plus every next key’s equal previous value proves key-set equality; removals cause count or lookup misses.
  let identical = nextKeys.length === Object.keys(previous).length
  const reconciled: Record<string, T> = {}
  for (const key of nextKeys) {
    const existing = Object.hasOwn(previous, key) ? previous[key] : undefined
    if (existing !== undefined && structuralValuesEqual(existing, next[key])) {
      reconciled[key] = existing
      continue
    }
    identical = false
    reconciled[key] = next[key]
  }
  return identical ? previous : reconciled
}
