import { useAppStore } from '@/store'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from './resolve-owner'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { writeWorkspaceFileDragSourceIfResolved } from './workspace-file-drag'

/** Source-control rows list the live workspace, so the owner is resolved now
 *  rather than captured with the listing (unlike the explorer's cached tree). */
export function writeWorkspaceFileDragSourceForWorkspace(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  workspaceId: string
): void {
  const state = useAppStore.getState()
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  // Why: a drop reads or uploads the files from the source host, so a twin names none.
  if (owner.kind === 'ambiguous') {
    return
  }
  const executionHostId = getKnownExecutionHostIdForWorktree(state, workspaceId)
  const runtimeEnvironmentId = owner.environmentId
  const sourceExecutionHostId =
    executionHostId === 'local' && runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : executionHostId
  writeWorkspaceFileDragSourceIfResolved(
    dataTransfer,
    workspaceId,
    sourceExecutionHostId,
    parseExecutionHostId(executionHostId)?.kind === 'ssh' ? runtimeEnvironmentId : undefined
  )
}
