import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import {
  isRendererMissionEligibleRepo,
  type MissionRepoEligibilityContext
} from './mission-repo-eligibility'

/** Mission-eligible repos contained in a project group's subtree. Group
 *  selection in mission pickers is a bulk-select convenience: membership is
 *  expanded to individual repos at selection time (snapshot, like Grove). */
export function getMissionEligibleGroupRepoIds(
  groups: readonly ProjectGroup[],
  repos: readonly Repo[],
  groupId: string,
  eligibilityContext: MissionRepoEligibilityContext
): string[] {
  const subtreeIds = getProjectGroupSubtreeIds(groups, groupId)
  return repos
    .filter(
      (repo) =>
        typeof repo.projectGroupId === 'string' &&
        subtreeIds.has(repo.projectGroupId) &&
        isRendererMissionEligibleRepo(repo, eligibilityContext)
    )
    .map((repo) => repo.id)
}
