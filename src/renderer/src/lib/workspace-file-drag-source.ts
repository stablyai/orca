import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { writeWorkspaceFileDragSourceIfResolved } from './workspace-file-drag'

/** Source-control rows list the live workspace, so the owner is resolved now
 *  rather than captured with the listing (unlike the explorer's cached tree). */
export function writeWorkspaceFileDragSourceForWorkspace(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  workspaceId: string
): void {
  writeWorkspaceFileDragSourceIfResolved(
    dataTransfer,
    workspaceId,
    getExecutionHostIdForWorktree(useAppStore.getState(), workspaceId)
  )
}
