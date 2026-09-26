import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

/**
 * Which host section a folder workspace's row belongs to.
 *
 * Single source of truth: header counting, host bucketing and reveal all resolve
 * the host through here. Two resolvers that drift is how folder workspaces went
 * missing from the sidebar in the first place (#15362). Deliberately distinct
 * from the host *filter* resolver, which also consults executionHostId — this
 * one must match where the row actually renders.
 */
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const connectionId = folderWorkspace.connectionId ?? projectGroup.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : defaultHostId
}

/**
 * Which host *owns* a folder workspace's `projectGroupId`, or undefined when the
 * row carries no host stamp at all. Group ids are unique per host, so every
 * lookup of that id must be scoped by this. Deliberately distinct from
 * getFolderWorkspaceHostId above, which answers where the row renders.
 */
export function getFolderWorkspaceProjectGroupHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>
): ExecutionHostId | undefined {
  return (
    normalizeExecutionHostId(folderWorkspace.executionHostId) ??
    (folderWorkspace.connectionId ? toSshExecutionHostId(folderWorkspace.connectionId) : undefined)
  )
}
