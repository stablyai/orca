import { MULTI_REPO_SYSTEM_GROUP_NAME } from '../multi-repo-workspace'
import type { ProjectGroup } from '../project-group-types'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'

/**
 * The host-created "Workspaces" group that holds multi-repo workspaces. It is a normal group to old
 * clients, so identity is the reserved name plus actually holding a multi-repo workspace: a group a
 * user named "Workspaces" themselves keeps its rename, delete and drag behavior.
 */
export function isMultiRepoSystemProjectGroup(
  group: Pick<ProjectGroup, 'name' | 'createdFrom'>,
  containsMultiRepoWorkspace: boolean
): boolean {
  return (
    containsMultiRepoWorkspace &&
    group.name === MULTI_REPO_SYSTEM_GROUP_NAME &&
    group.createdFrom === 'manual'
  )
}

/**
 * The Workspaces section creates across repos, so its "+" preselects no project or folder group;
 * every other group preselects itself.
 */
export function composerDataForProjectGroup(
  group: Pick<ProjectGroup, 'id' | 'name' | 'createdFrom'>,
  folderWorkspaces: readonly Pick<FolderWorkspace, 'projectGroupId' | 'multiRepo'>[]
): { initialProjectGroupId?: string; telemetrySource: 'sidebar' } {
  const holdsMultiRepo = folderWorkspaces.some(
    (workspace) => workspace.projectGroupId === group.id && workspace.multiRepo !== undefined
  )
  return isMultiRepoSystemProjectGroup(group, holdsMultiRepo)
    ? { telemetrySource: 'sidebar' }
    : { initialProjectGroupId: group.id, telemetrySource: 'sidebar' }
}
