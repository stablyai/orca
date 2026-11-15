import { isPathInsideOrEqual } from '../cross-platform-path'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { getProjectGroupSubtreeIds } from '../project/groups/project-groups'
import { isGitRepoKind } from '../repository/repo-kind'

import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'

const EMPTY_REPOS: Repo[] = []

function getProjectGroupExecutionHostId(projectGroup: ProjectGroup): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(projectGroup.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  return getConnectionExecutionHostId(projectGroup.connectionId)
}

export function getFolderSourceRepos(
  repos: readonly Repo[],
  projectGroups: readonly ProjectGroup[],
  projectGroup: ProjectGroup | null
): Repo[] {
  if (!projectGroup?.parentPath) {
    return EMPTY_REPOS
  }
  const folderPath = projectGroup.parentPath
  const groupIds = getProjectGroupSubtreeIds(projectGroups, projectGroup.id)
  const projectGroupHostId = getProjectGroupExecutionHostId(projectGroup)
  return repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
      getRepoExecutionHostId(repo) === projectGroupHostId &&
      ((typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
        isPathInsideOrEqual(folderPath, repo.path))
  )
}
