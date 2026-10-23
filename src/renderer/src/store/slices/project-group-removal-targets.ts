import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { catalogOwnsHost, getProjectGroupHostId } from './project-group-owner-routing'

export type ProjectGroupRemovalProject = { id: string; hostId: ExecutionHostId }

export type ProjectGroupRemovalTargets = {
  groupExists: boolean
  deletedGroupIds: Set<string>
  projectIds: string[]
  // Why: ids repeat across hosts and membership is per row, so removal must target the exact member rows.
  projects: ProjectGroupRemovalProject[]
}

export function selectProjectGroupRemovalTargets(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  groupId: string,
  // Why: ids repeat across hosts; without an owner host the caller would target another host's rows.
  hostId?: ExecutionHostId | null
): ProjectGroupRemovalTargets {
  const ownsRowHost = (rowHostId: string): boolean =>
    hostId ? catalogOwnsHost(hostId, rowHostId) : true
  const ownerGroups = hostId
    ? projectGroups.filter((group) => ownsRowHost(getProjectGroupHostId(group)))
    : projectGroups
  const groupExists = ownerGroups.some((group) => group.id === groupId)
  if (!groupExists) {
    return {
      groupExists: false,
      deletedGroupIds: new Set(),
      projectIds: [],
      projects: []
    }
  }

  const deletedGroupIds = getProjectGroupSubtreeIds(ownerGroups, groupId)
  const projectIds: string[] = []
  const projects: ProjectGroupRemovalProject[] = []
  for (const repo of repos) {
    const repoHostId = getRepoExecutionHostId(repo)
    if (
      repo.projectGroupId &&
      deletedGroupIds.has(repo.projectGroupId) &&
      ownsRowHost(repoHostId)
    ) {
      projectIds.push(repo.id)
      projects.push({ id: repo.id, hostId: repoHostId })
    }
  }

  return {
    groupExists: true,
    deletedGroupIds,
    projectIds,
    projects
  }
}
