import '../../../../../../shared/new-workspace/workspace-source'
import { isPathInsideOrEqual } from '../../../../../../shared/cross-platform-path'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getProjectGroupSubtreeIds } from '../../../../../../shared/project-groups'
import { isGitRepoKind } from '../../../../../../shared/repo-kind'

import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

import '@/i18n/i18n'

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
