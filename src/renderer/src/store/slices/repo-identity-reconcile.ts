import type { Repo } from '../../../../shared/types'
import { getRepoHostIdentity } from './repo-host-identity'

// Why: after a drag-reorder we optimistically set `repos`, persist, and main
// broadcasts `repos:changed`. The renderer's own echo handler refetches, which
// would otherwise hand back field-identical repos as brand-new objects. New
// identities invalidate the repoMap/repoOrder/rows memos and force the
// virtualizer to rebuild + re-measure a tick after the drop — the visible jump.
// Reusing equal objects (and the whole array when nothing moved) makes the echo
// a no-op render.
// Why: `Repo` carries nested records (hookSettings, upstream, gitRemoteIdentity, repoIcon, path
// arrays). IPC structured-clone rebuilds those every fetch, and main's hydrateRepo always
// reconstructs hookSettings — so a reference compare reports every repo as changed and no repo
// ever reconciles. Compare nested plain values structurally; they are small sanitized records.
export function areValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => areValuesEqual(item, b[index]))
    )
  }
  // Why: only plain records are safe to walk — anything exotic falls back to reference equality.
  const aPrototype = Object.getPrototypeOf(a)
  const bPrototype = Object.getPrototypeOf(b)
  if (
    (aPrototype !== Object.prototype && aPrototype !== null) ||
    (bPrototype !== Object.prototype && bPrototype !== null)
  ) {
    return false
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  if (keys.length !== Object.keys(bRecord).length) {
    return false
  }
  return keys.every(
    (key) => Object.hasOwn(bRecord, key) && areValuesEqual(aRecord[key], bRecord[key])
  )
}

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
    if (existing !== undefined && areValuesEqual(existing, row)) {
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
    if (existing !== undefined && areValuesEqual(existing, next[key])) {
      reconciled[key] = existing
      continue
    }
    identical = false
    reconciled[key] = next[key]
  }
  return identical ? previous : reconciled
}
