import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'
import { reconcileFetchedRepos } from './repo-identity-reconcile'

function getRepoOwnerKey(repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>): string {
  // Why: repo ids are only guaranteed unique inside one host's store. A runtime
  // refresh must not replace a same-id local or sibling-runtime checkout.
  return `${getRepoExecutionHostId(repo)}\0${repo.id}`
}

export function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: Repo[],
  hostId: ExecutionHostId
): Repo[] {
  const fetchedOwnerKeys = new Set(fetched.map(getRepoOwnerKey))
  const preserved = previous.filter((repo) => {
    const existingHostId = getRepoExecutionHostId(repo)
    return existingHostId !== hostId || fetchedOwnerKeys.has(getRepoOwnerKey(repo))
  })
  const merged = [...preserved]
  const indexByOwnerKey = new Map(merged.map((repo, index) => [getRepoOwnerKey(repo), index]))
  for (const repo of fetched) {
    const ownerKey = getRepoOwnerKey(repo)
    const existingIndex = indexByOwnerKey.get(ownerKey)
    if (existingIndex === undefined) {
      indexByOwnerKey.set(ownerKey, merged.length)
      merged.push(repo)
      continue
    }
    merged[existingIndex] = repo
  }
  return reconcileFetchedRepos(previous, merged)
}
