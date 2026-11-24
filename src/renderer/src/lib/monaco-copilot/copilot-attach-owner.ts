import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { authorityKey } from '../../../../shared/execution-host/host-authority'
import type { AppState } from '@/store/types'
import { isFileOnLocalHostFromState } from '@/lib/workspace/ownership/connection-owner-resolution'

type CopilotAttachOwnerState = Pick<
  AppState,
  'openFiles' | 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

/**
 * True only when every owner signal places the editor's file on this machine, since the server
 * runs locally. A tab opened through a runtime or SSH target, or a workspace host that isn't
 * provably local, fails closed. Routes by the file's owner, not the Active Server setting.
 */
export function isCopilotAttachOwnerLocal(
  state: CopilotAttachOwnerState,
  file: { fileId: string; filePath: string; worktreeId: string | null }
): boolean {
  const openFile = state.openFiles?.find((candidate) => candidate.id === file.fileId)
  if (!openFile || openFile.runtimeEnvironmentId?.trim() || openFile.externalSshTargetId?.trim()) {
    return false
  }
  const generation = openFile.operationProvenance?.generation
  if (
    generation &&
    (generation.route.runtimeEnvironmentId ||
      generation.route.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      (generation.authority && authorityKey(generation.authority) !== LOCAL_EXECUTION_HOST_ID))
  ) {
    return false
  }
  return isFileOnLocalHostFromState(state, file.worktreeId, file.filePath)
}
