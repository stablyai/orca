import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { TerminalFileOwner } from './terminal-file-owner'

export type TerminalFileEditorTarget = {
  worktreeId: string
  relativePath: string
  executionHostId?: ExecutionHostId
  /** `null` pins this client as the owner; `undefined` keeps the pane's. */
  runtimeEnvironmentId: string | null | undefined
  readOnly: boolean
}

export function resolveTerminalFileEditorTarget(
  state: AppState,
  owner: TerminalFileOwner,
  filePath: string,
  pane: { worktreeId: string; worktreePath: string; runtimeEnvironmentId?: string | null }
): TerminalFileEditorTarget {
  const paneTarget = {
    worktreeId: pane.worktreeId,
    relativePath: filePath,
    runtimeEnvironmentId: pane.runtimeEnvironmentId,
    readOnly: false
  }
  if (owner.kind === 'runtime-sibling') {
    const { route } = owner
    return {
      ...paneTarget,
      worktreeId: route.worktreeId,
      relativePath: route.relativePath,
      executionHostId: route.executionHostId
    }
  }
  if (owner.kind === 'client') {
    const localRoute = findWorkspaceFileRoute(state, LOCAL_EXECUTION_HOST_ID, filePath)
    return localRoute
      ? {
          worktreeId: localRoute.worktreeId,
          relativePath: localRoute.relativePath,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          runtimeEnvironmentId: null,
          readOnly: false
        }
      : // Why: an editable tab must share its workspace's host, so a client file shown in a
        // runtime workspace opens read-only, like AI Vault logs.
        {
          ...paneTarget,
          executionHostId: owner.paneExecutionHostId,
          runtimeEnvironmentId: null,
          readOnly: true
        }
  }

  const { worktreePath, worktreeId } = pane
  if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
    const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
    return maybeRelative !== null && maybeRelative.length > 0
      ? { ...paneTarget, relativePath: maybeRelative }
      : paneTarget
  }
  if (
    !state.openFiles.some(
      (openFile) => openFile.filePath === filePath && openFile.worktreeId !== worktreeId
    )
  ) {
    return paneTarget
  }
  // Why: early resolution is only needed to avoid an existing sibling-tab collision.
  const { fileContext } = owner
  const runtimeOwnerId = fileContext.settings?.activeRuntimeEnvironmentId?.trim()
  const executionHostId = runtimeOwnerId
    ? toRuntimeExecutionHostId(runtimeOwnerId)
    : fileContext.connectionId
      ? toSshExecutionHostId(fileContext.connectionId)
      : LOCAL_EXECUTION_HOST_ID
  const siblingRoute = findWorkspaceFileRoute(state, executionHostId, filePath)
  return siblingRoute
    ? {
        ...paneTarget,
        worktreeId: siblingRoute.worktreeId,
        relativePath: siblingRoute.relativePath,
        executionHostId: siblingRoute.executionHostId
      }
    : paneTarget
}
