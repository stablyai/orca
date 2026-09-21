import type { Repo } from '../../../../shared/repo-types'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import { reconcileFetchedRepos } from '../slices/repo-identity-reconcile'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'
import { mergeFetchedProjectCompatibilityForHost } from '../projects/project-compatibility-host-merge'
import { projectCompatibilityFromRepos } from '../projects/project-compatibility-core'
import { mergeByIdentity } from '../catalog-identity'

export function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: readonly Repo[],
  hostId: string
): readonly Repo[] {
  const fetchedWithProjectGroups = applyInheritedProjectGroups(previous, fetched)
  const fetchedIdentities = new Set(fetchedWithProjectGroups.map(getRepoHostIdentity))
  const preserved = previous.filter((repo) => {
    const existingHostId = getRepoExecutionHostId(repo)
    return existingHostId !== hostId || fetchedIdentities.has(getRepoHostIdentity(repo))
  })
  return reconcileFetchedRepos(
    previous,
    mergeByIdentity(preserved, fetchedWithProjectGroups, getRepoHostIdentity)
  )
}

export function applyInheritedProjectGroups(
  previous: readonly Repo[],
  fetched: readonly Repo[]
): Repo[] {
  const projectGroupIdByProject = new Map<string, string | null>()
  for (const repo of previous) {
    const projectGroupId =
      repo.projectGroupId === undefined ? undefined : (repo.projectGroupId ?? null)
    if (projectGroupId === undefined) {
      continue
    }
    const projectId = getProjectIdentityKey(repo)
    if (projectId.startsWith('repo:')) {
      continue
    }
    if (!projectGroupIdByProject.has(projectId)) {
      projectGroupIdByProject.set(projectId, projectGroupId)
    }
  }
  if (projectGroupIdByProject.size === 0) {
    return [...fetched]
  }
  return fetched.map((repo) => {
    if (repo.projectGroupId !== undefined) {
      return repo
    }
    const inheritedProjectGroupId = projectGroupIdByProject.get(getProjectIdentityKey(repo))
    if (inheritedProjectGroupId === undefined) {
      return repo
    }
    // Why: project groups are a local affordance; runtime copies of the same canonical project should appear in the user's existing group.
    return { ...repo, projectGroupId: inheritedProjectGroupId }
  })
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
