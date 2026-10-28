import { MULTI_REPO_SYSTEM_GROUP_NAME } from '../multi-repo-workspace'
import type { ProjectGroup } from '../project-group-types'

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
