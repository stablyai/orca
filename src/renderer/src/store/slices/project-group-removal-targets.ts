import type { ProjectGroup, Repo } from '../../../../shared/types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'

export type ProjectGroupRemovalTargets = {
  groupExists: boolean
  deletedGroupIds: Set<string>
  projectIds: string[]
}

export function selectProjectGroupRemovalTargets(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  groupId: string
): ProjectGroupRemovalTargets {
  const groupExists = projectGroups.some((group) => group.id === groupId)
  if (!groupExists) {
    return {
      groupExists: false,
      deletedGroupIds: new Set(),
      projectIds: []
    }
  }

  const deletedGroupIds = getProjectGroupSubtreeIds(projectGroups, groupId)
  const projectIds: string[] = []
  for (const repo of repos) {
    if (repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)) {
      projectIds.push(repo.id)
    }
  }

  return {
    groupExists: true,
    deletedGroupIds,
    projectIds
  }
}
