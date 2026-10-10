import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { resolveProjectGroupEnv } from '../../../../shared/project-group-members'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

/**
 * Group env for a workspace. Worktree workspaces resolve the group through their repo;
 * folder workspaces carry it directly.
 */
export function buildProjectGroupWorkspaceEnv(
  state: { repos: readonly Repo[]; projectGroups: readonly ProjectGroup[] },
  worktreeId: string,
  folderWorkspace: Pick<FolderWorkspace, 'projectGroupId'> | null | undefined
): Record<string, string> {
  const projectGroupId = folderWorkspace
    ? folderWorkspace.projectGroupId
    : state.repos.find((repo) => repo.id === getRepoIdFromWorktreeId(worktreeId))?.projectGroupId
  return resolveProjectGroupEnv(projectGroupId, state.repos, state.projectGroups)
}
