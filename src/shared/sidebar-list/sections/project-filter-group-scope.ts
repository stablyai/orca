import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { Repo } from '../../repository/repo-types'
import {
  NO_HIDDEN_PROJECTS,
  withoutHiddenFilterRepoIds,
  type HiddenProjects
} from '../../project/catalog/hidden-projects'

/** Under a project filter, keeps only groups holding a selected repo, plus their ancestors. */
export function filterProjectGroupsForRepoFilter(args: {
  projectGroups: readonly ProjectGroup[]
  repoMap: ReadonlyMap<string, Repo>
  filterRepoIds: readonly string[]
  hiddenProjects?: HiddenProjects
}): readonly ProjectGroup[] {
  const { projectGroups, repoMap } = args
  const filterRepoIds = withoutHiddenFilterRepoIds(
    args.filterRepoIds,
    args.hiddenProjects ?? NO_HIDDEN_PROJECTS
  )
  if (filterRepoIds.length === 0 || projectGroups.length === 0) {
    return projectGroups
  }
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const keptGroupIds = new Set<string>()
  for (const repoId of filterRepoIds) {
    let group = groupsById.get(repoMap.get(repoId)?.projectGroupId ?? '')
    while (group && !keptGroupIds.has(group.id)) {
      keptGroupIds.add(group.id)
      group = group.parentGroupId ? groupsById.get(group.parentGroupId) : undefined
    }
  }
  return projectGroups.filter((group) => keptGroupIds.has(group.id))
}
