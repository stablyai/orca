import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

/** Git repos whose tasks the quick panel lists: the active repo, or every repo of a folder workspace's group. */
export function getQuickTasksRepos(args: {
  activeWorkspaceKey: string | null
  activeRepo: Repo | null
  folderWorkspaces: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId'>[]
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[]
  repos: readonly Repo[]
}): Repo[] {
  const scope = parseWorkspaceKey(args.activeWorkspaceKey ?? '')
  if (scope?.type !== 'folder') {
    return args.activeRepo && isGitRepoKind(args.activeRepo) ? [args.activeRepo] : []
  }
  const folderWorkspace = args.folderWorkspaces.find(
    (workspace) => workspace.id === scope.folderWorkspaceId
  )
  if (!folderWorkspace) {
    return []
  }
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, folderWorkspace.projectGroupId)
  return args.repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
      typeof repo.projectGroupId === 'string' &&
      groupIds.has(repo.projectGroupId)
  )
}
