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
function areValuesEqual(a: unknown, b: unknown): boolean {
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
  if (
    Object.getPrototypeOf(a) !== Object.prototype ||
    Object.getPrototypeOf(b) !== Object.prototype
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

function areReposEqual(a: Repo, b: Repo): boolean {
  if (a === b) {
    return true
  }
  const keys = Object.keys(a) as (keyof Repo)[]
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) {
      return false
    }
    if (!areValuesEqual(a[key], b[key])) {
      return false
    }
  }
  return true
}

export function reconcileFetchedRepos(
  previous: readonly Repo[],
  next: readonly Repo[]
): readonly Repo[] {
  const previousById = new Map(previous.map((repo) => [getRepoHostIdentity(repo), repo]))
  let identical = next.length === previous.length
  const reconciled = next.map((repo, index) => {
    const existing = previousById.get(getRepoHostIdentity(repo))
    if (existing && areReposEqual(existing, repo)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return repo
  })
  return identical ? previous : reconciled
}
