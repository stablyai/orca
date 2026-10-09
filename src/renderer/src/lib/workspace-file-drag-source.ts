import { useAppStore } from '@/store'
import {
  getKnownExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { writeWorkspaceFileDragSourceIfResolved } from './workspace-file-drag'

/** Source-control rows list the live workspace, so the owner is resolved now
 *  rather than captured with the listing (unlike the explorer's cached tree). */
export function writeWorkspaceFileDragSourceForWorkspace(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  workspaceId: string
): void {
  const state = useAppStore.getState()
  const executionHostId = getKnownExecutionHostIdForWorktree(state, workspaceId)
  writeWorkspaceFileDragSourceIfResolved(
    dataTransfer,
    workspaceId,
    executionHostId,
    parseExecutionHostId(executionHostId)?.kind === 'ssh'
      ? getExplicitRuntimeEnvironmentIdForWorktree(state, workspaceId)
      : undefined
  )
}
