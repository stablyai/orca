import { getProjectIdentityKey } from './project-host-setup-projection'
import type { Repo } from './repo-types'

/** Fetched repos that name no group take the group another host's copy of the same project has. */
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
