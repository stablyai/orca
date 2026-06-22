import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'
import { reconcileFetchedRepos } from './repo-identity-reconcile'

export function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: Repo[],
  hostId: ExecutionHostId
): Repo[] {
  const firstHostIndex = previous.findIndex((repo) => getRepoExecutionHostId(repo) === hostId)
  const preserved = previous.filter((repo) => getRepoExecutionHostId(repo) !== hostId)
  if (firstHostIndex === -1) {
    return reconcileFetchedRepos(previous, [...preserved, ...fetched])
  }
  const insertAt = Math.min(firstHostIndex, preserved.length)
  const merged = [...preserved.slice(0, insertAt), ...fetched, ...preserved.slice(insertAt)]
  return reconcileFetchedRepos(previous, merged)
}
