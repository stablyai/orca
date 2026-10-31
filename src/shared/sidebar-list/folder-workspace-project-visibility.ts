import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'

/** Keep folder workspaces only when their project group contains a selected project. */
export function filterFolderWorkspacesForSelectedProjects(
  folderWorkspaces: readonly FolderWorkspace[],
  repos: readonly Repo[],
  filterRepoIds: readonly string[]
): readonly FolderWorkspace[] {
  if (filterRepoIds.length === 0) {
    return folderWorkspaces
  }
  const selectedRepoIds = new Set(filterRepoIds)
  const selectedProjectGroupIds = new Set(
    repos.flatMap((repo) =>
      selectedRepoIds.has(repo.id) && repo.projectGroupId ? [repo.projectGroupId] : []
    )
  )
  return folderWorkspaces.filter((folderWorkspace) =>
    selectedProjectGroupIds.has(folderWorkspace.projectGroupId)
  )
}
