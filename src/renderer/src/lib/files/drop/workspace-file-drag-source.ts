import { useAppStore } from '@/store/index'
import { getKnownExecutionHostIdForWorktree } from '../../workspace/ownership/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '../../workspace/ownership/resolve-owner'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  isResolvedWorkspaceFileDragExecutionHost,
  writeWorkspaceFileDragSource,
  type WorkspaceFileDragSource
} from './workspace-file-drag'
import type { AppState } from '@/store/types'

/** The stamp a drag from this workspace carries now; null when no single host owns it. */
export function currentWorkspaceFileDragSource(
  state: AppState,
  workspaceId: string
): WorkspaceFileDragSource | null {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  // Why: a drop reads or uploads the files from the source host, so a twin names none.
  if (owner.kind === 'ambiguous') {
    return null
  }
  const executionHostId = getKnownExecutionHostIdForWorktree(state, workspaceId)
  const runtimeEnvironmentId = owner.environmentId
  if (!executionHostId || !isResolvedWorkspaceFileDragExecutionHost(executionHostId)) {
    return null
  }
  const ssh = parseExecutionHostId(executionHostId)?.kind === 'ssh'
  return {
    executionHostId:
      executionHostId === 'local' && runtimeEnvironmentId
        ? toRuntimeExecutionHostId(runtimeEnvironmentId)
        : executionHostId,
    workspaceId,
    ...(ssh && runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  }
}

/** Source-control rows list the live workspace, so the owner is resolved now
 *  rather than captured with the listing (unlike the explorer's cached tree). */
export function writeWorkspaceFileDragSourceForWorkspace(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  workspaceId: string
): void {
  const source = currentWorkspaceFileDragSource(useAppStore.getState(), workspaceId)
  if (source) {
    writeWorkspaceFileDragSource(dataTransfer, source)
  }
}
