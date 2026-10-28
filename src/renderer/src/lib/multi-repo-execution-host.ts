import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'

/**
 * Host that owns a multi-repo workspace in this app. Adoption stamps the runtime host on the folder
 * workspace; `multiRepo.executionHostId` keeps the id the owning host wrote about itself ('local'),
 * which host-qualified lookups and actions cannot resolve for a remote runtime.
 */
export function resolveMultiRepoExecutionHostId(
  folderWorkspace: Pick<FolderWorkspace, 'executionHostId' | 'multiRepo'>
): ExecutionHostId | undefined {
  return folderWorkspace.executionHostId ?? folderWorkspace.multiRepo?.executionHostId
}
