import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

/**
 * Narrows project groups to the ones that still have something to show under an
 * active project filter: groups holding a selected repo, plus every ancestor so
 * the hierarchy above a match stays intact. No filter means every group. #9145
 */
export function filterProjectGroupsForRepoFilter(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  filterRepoIds: readonly string[]
): readonly ProjectGroup[] {
  if (filterRepoIds.length === 0 || projectGroups.length === 0) {
    return projectGroups
  }
  const selectedRepoIds = new Set(filterRepoIds)
  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const keptGroupIds = new Set<string>()
  for (const repo of repos) {
    if (!selectedRepoIds.has(repo.id)) {
      continue
    }
    let groupId = repo.projectGroupId ?? null
    while (groupId && !keptGroupIds.has(groupId)) {
      const group = projectGroupsById.get(groupId)
      if (!group) {
        break
      }
      keptGroupIds.add(group.id)
      groupId = group.parentGroupId
    }
  }
  return projectGroups.filter((group) => keptGroupIds.has(group.id))
}
