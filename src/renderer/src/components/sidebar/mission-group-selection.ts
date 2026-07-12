import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isMissionEligibleRepo } from '../../../../shared/missions'
import type { ProjectGroup, Repo } from '../../../../shared/types'

/** Mission-eligible repos contained in a project group's subtree. Group
 *  selection in mission pickers is a bulk-select convenience: membership is
 *  expanded to individual repos at selection time (snapshot, like Grove). */
export function getMissionEligibleGroupRepoIds(
  groups: readonly ProjectGroup[],
  repos: readonly Repo[],
  groupId: string
): string[] {
  const subtreeIds = getProjectGroupSubtreeIds(groups, groupId)
  return repos
    .filter(
      (repo) =>
        typeof repo.projectGroupId === 'string' &&
        subtreeIds.has(repo.projectGroupId) &&
        isMissionEligibleRepo(repo)
    )
    .map((repo) => repo.id)
}
