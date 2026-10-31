import type { AppState } from '@/store/types'
import { isFileOnLocalHostFromState } from '@/lib/connection-owner-resolution'

type CopilotAttachOwnerState = Pick<
  AppState,
  'settings' | 'openFiles' | 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

/**
 * True only when every owner signal places the editor's file on this machine, since the server
 * runs locally. An active runtime, a tab opened through a runtime or SSH target, or a workspace
 * host that isn't provably local all fail closed.
 */
export function isCopilotAttachOwnerLocal(
  state: CopilotAttachOwnerState,
  file: { fileId: string; filePath: string; worktreeId: string | null }
): boolean {
  if (state.settings?.activeRuntimeEnvironmentId?.trim()) {
    return false
  }
  const openFile = state.openFiles?.find((candidate) => candidate.id === file.fileId)
  if (openFile?.runtimeEnvironmentId?.trim() || openFile?.externalSshTargetId?.trim()) {
    return false
  }
  return isFileOnLocalHostFromState(state, file.worktreeId, file.filePath)
}
