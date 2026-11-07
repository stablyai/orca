import type { Repo } from '../../../../shared/repo-types'
import { applyInheritedProjectGroups } from '../../../../shared/project-group-inheritance'
import { reconcileCatalogRows } from '../../../../shared/catalog-row-reconcile'
import { getRepoRowIdentity } from './repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'
import { mergeFetchedProjectCompatibilityForHost } from '../../../../shared/project-compatibility-host-merge'
import { projectCompatibilityFromRepos } from '../../../../shared/project-compatibility-merge'
import { mergeByIdentity } from '../catalog-identity'
import { isSavedHostCatalogRow } from './saved-host-catalog-rows'

export function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: readonly Repo[],
  hostId: string,
  /** The rows when the request went out; omitted, every row of the host is the answer's to drop. */
  reposAtRequest?: readonly Repo[]
): readonly Repo[] {
  const fetchedWithProjectGroups = applyInheritedProjectGroups(previous, fetched)
  const fetchedIdentities = new Set(fetchedWithProjectGroups.map(getRepoRowIdentity))
  const requested = reposAtRequest ? new Set(reposAtRequest.map(getRepoRowIdentity)) : null
  const preserved = previous.filter((repo) => {
    const identity = getRepoRowIdentity(repo)
    return (
      getRepoExecutionHostId(repo) !== hostId ||
      fetchedIdentities.has(identity) ||
      // Added after the request: an answer that predates it cannot drop it.
      (requested !== null && !requested.has(identity) && !isSavedHostCatalogRow(repo))
    )
  })
  return reconcileCatalogRows(
    previous,
    mergeByIdentity(preserved, fetchedWithProjectGroups, getRepoRowIdentity),
    getRepoRowIdentity
  )
}

export function mergeProjectCompatibilityForHostRepoChange({
  previous,
  nextRepos,
  hostId
}: {
  previous: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  nextRepos: readonly Repo[]
  hostId: string
}): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  return mergeFetchedProjectCompatibilityForHost({
    previous,
    fetched: projectCompatibilityFromRepos(nextRepos),
    repos: nextRepos,
    hostId
  })
}
