import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import {
  isPathInsideWorktree,
  toWorktreeRelativePath
} from '../../../../shared/terminal/links/terminal-links'
import { useAppStore } from '@/store'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { TerminalFileContext } from './terminal-file-path-mapping'

export type LinkedFileEditorTarget = {
  worktreeId: string
  executionHostId: ExecutionHostId
  relativePath: string
}

/** The workspace, host and path an editor tab for a linked file opens under. */
export function resolveLinkedFileEditorTarget(args: {
  filePath: string
  worktreeId: string
  worktreePath: string
  fileContext: TerminalFileContext
  sourceRuntimeOwnerId: string | null | undefined
  hostExecutionHostId: ExecutionHostId | undefined
  granted: boolean
  escapesWorktree: boolean
}): LinkedFileEditorTarget {
  const { filePath, worktreeId, worktreePath, fileContext } = args
  const runtimeOwnerId = runtimeTargetEnvironmentId(fileContext.target) ?? args.sourceRuntimeOwnerId
  const executionHostId =
    args.hostExecutionHostId ??
    (runtimeOwnerId
      ? toRuntimeExecutionHostId(runtimeOwnerId)
      : getConnectionExecutionHostId(fileContext.connectionId))
  if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
    const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
    // Keep out-of-project absolute paths so restored tabs still name the user’s external file instead of refusing it as a project file.
    const relativePath =
      maybeRelative !== null && maybeRelative.length > 0 && !args.escapesWorktree
        ? maybeRelative
        : filePath
    return { worktreeId, executionHostId, relativePath }
  }
  const store = useAppStore.getState()
  if (
    !args.granted &&
    !isFloatingWorkspaceId(worktreeId) &&
    // Why: a local file opens in the workspace it was clicked in, even if another holds it open;
    // owner-scoped tab ids keep both tabs, and the editor reads local absolute paths directly.
    executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    store.openFiles.some(
      (openFile) => openFile.filePath === filePath && openFile.worktreeId !== worktreeId
    )
  ) {
    // Why: early resolution is only needed to avoid an existing sibling-tab collision.
    const siblingRoute = findWorkspaceFileRoute(store, executionHostId, filePath)
    if (siblingRoute) {
      return siblingRoute
    }
  }
  return { worktreeId, executionHostId, relativePath: filePath }
}
