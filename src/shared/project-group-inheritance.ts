import type { ProjectGroupingSettings } from './project-grouping'
import {
  buildRepoProjectGroupingIndex,
  getProjectGroupForRepo,
  type ProjectGroupingIndex
} from './project-section-grouping'
import type { Repo } from './repo-types'

/** Fetched repos that name no group take the group another host's copy of the same project has. */
export function applyInheritedProjectGroups(
  previous: readonly Repo[],
  fetched: readonly Repo[],
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): Repo[] {
  const index = grouping ?? buildRepoProjectGroupingIndex([...previous, ...fetched], settings)
  const projectGroupIdByProject = new Map<string, string | null>()
  for (const repo of previous) {
    const projectGroupId =
      repo.projectGroupId === undefined ? undefined : (repo.projectGroupId ?? null)
    if (projectGroupId === undefined) {
      continue
    }
    const projectId = getProjectGroupForRepo(index, repo)?.key ?? `project:repo:${repo.id}`
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
    const inheritedProjectGroupId = projectGroupIdByProject.get(
      getProjectGroupForRepo(index, repo)?.key ?? `project:repo:${repo.id}`
    )
    if (inheritedProjectGroupId === undefined) {
      return repo
    }
    // Why: project groups are a local affordance; runtime copies of the same canonical project should appear in the user's existing group.
    return { ...repo, projectGroupId: inheritedProjectGroupId }
  })
}
