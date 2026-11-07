import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'

const repoMapCache = new WeakMap<
  AppState['repos'],
  { byId: Map<string, Repo>; rowsById: Map<string, Repo[]> }
>()

function getRepoSnapshot(repos: AppState['repos']) {
  const cached = repoMapCache.get(repos)
  if (cached) {
    return cached
  }
  const byId = new Map<string, Repo>()
  const rowsById = new Map<string, Repo[]>()
  for (const repo of repos) {
    const id = repo.id
    byId.set(id, repo)
    const rows = rowsById.get(id)
    if (rows) {
      rows.push(repo)
    } else {
      rowsById.set(id, [repo])
    }
  }
  const snapshot = { byId, rowsById }
  repoMapCache.set(repos, snapshot)
  return snapshot
}

export function getIndexedRepoMap(repos: AppState['repos']): Map<string, Repo> {
  return getRepoSnapshot(repos).byId
}

/** Preserve every physical row so callers can reject same-host duplicates too. */
export function getIndexedReposById(repos: AppState['repos'], repoId: string): readonly Repo[] {
  return getRepoSnapshot(repos).rowsById.get(repoId) ?? []
}
