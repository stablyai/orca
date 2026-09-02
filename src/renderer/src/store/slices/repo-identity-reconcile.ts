import type { Repo } from '../../../../shared/repo-types'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { getRepoHostIdentity } from './repo-host-identity'

// Why: after a drag-reorder we optimistically set `repos`, persist, and main
// broadcasts `repos:changed`. The renderer's own echo handler refetches, which
// would otherwise hand back field-identical repos as brand-new objects. New
// identities invalidate the repoMap/repoOrder/rows memos and force the
// virtualizer to rebuild + re-measure a tick after the drop — the visible jump.
// Reusing equal objects (and the whole array when nothing moved) makes the echo
// a no-op render.
// Why the structural compare: `Repo` carries nested records (hookSettings, upstream,
// gitRemoteIdentity, repoIcon, path arrays) that structured-clone and main's hydrateRepo rebuild
// every fetch, so a reference compare would report every repo as changed.

/**
 * Reuses equal rows from `previous` — and the whole array when nothing moved — so a refetch that
 * changed nothing leaves identity-keyed memos and store subscribers untouched. `getIdentity` must
 * be the key the producing merge already dedups by, so it is unique within `next`.
 */
export function reconcileCatalogRows<T>(
  previous: readonly T[],
  next: readonly T[],
  getIdentity: (row: T) => string
): readonly T[] {
  const previousByIdentity = new Map(previous.map((row) => [getIdentity(row), row]))
  let identical = next.length === previous.length
  const reconciled = next.map((row, index) => {
    const existing = previousByIdentity.get(getIdentity(row))
    if (existing !== undefined && structuralValuesEqual(existing, row)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return row
  })
  return identical ? previous : reconciled
}

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
  // Why: a matching key count plus every `next` key resolving to an equal `previous` entry below
  // means the key sets match, so a removed key always lands as either a count or a lookup miss.
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
