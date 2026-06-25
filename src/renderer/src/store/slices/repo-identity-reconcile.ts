import type { Repo } from '../../../../shared/types'
import { getRepoHostIdentity } from './repo-host-identity'

// Why: after a drag-reorder we optimistically set `repos`, persist, and main
// broadcasts `repos:changed`. The renderer's own echo handler refetches, which
// would otherwise hand back field-identical repos as brand-new objects. New
// identities invalidate the repoMap/repoOrder/rows memos and force the
// virtualizer to rebuild + re-measure a tick after the drop — the visible jump.
// Reusing equal objects (and the whole array when nothing moved) makes the echo
// a no-op render.
function areReposEqual(a: Repo, b: Repo): boolean {
  if (a === b) {
    return true
  }
  const keys = Object.keys(a) as (keyof Repo)[]
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false
    }
    if (a[key] !== b[key]) {
      return false
    }
  }
  return true
}

export function reconcileFetchedRepos(previous: readonly Repo[], next: Repo[]): Repo[] {
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
  return identical ? (previous as Repo[]) : reconciled
}
