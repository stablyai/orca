import type { AppState } from '@/store/types'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

type RichMarkdownOperationContext = ReturnType<typeof getEditorFileOperationContext>

export type RichMarkdownFileOwner = {
  operationContext: RichMarkdownOperationContext
  sourceOwner: HttpLinkSourceOwner
  worktreeRoot: string | null
}

export function resolveRichMarkdownWorktreeRoot(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const owner = findIndexedFolderWorkspaceOwner(
      state.folderWorkspaces,
      workspaceScope.folderWorkspaceId,
      executionHostId
    )
    return state.folderWorkspaces.find((workspace) => workspace === owner)?.folderPath ?? null
  }
  const owner = executionHostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, executionHostId)
    : findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  return (
    Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree === owner)?.path ?? null
  )
}

export function resolveRichMarkdownFileOwner(
  state: AppState,
  fileId: string,
  filePath: string,
  worktreeId: string
): RichMarkdownFileOwner | null {
  const file = state.openFiles.find(
    (candidate) =>
      candidate.id === fileId &&
      candidate.filePath === filePath &&
      candidate.worktreeId === worktreeId
  )
  if (!file) {
    return null
  }
  const ownerHostId = parseExecutionHostId(
    file.operationProvenance?.generation.route.executionHostId ?? file.workspaceExecutionHostId
  )?.id
  const indexedRoot = resolveRichMarkdownWorktreeRoot(state, worktreeId, ownerHostId)
  try {
    const operationContext = getEditorFileOperationContext(state, file, indexedRoot)
    const runtimeEnvironmentId = operationContext.settings?.activeRuntimeEnvironmentId?.trim()
    const sourceOwner: HttpLinkSourceOwner = runtimeEnvironmentId
      ? { kind: 'runtime', runtimeEnvironmentId }
      : operationContext.connectionId
        ? { kind: 'ssh', connectionId: operationContext.connectionId }
        : operationContext.expectedExecutionHostId === 'local'
          ? { kind: 'local' }
          : { kind: 'unknown' }
    if (sourceOwner.kind === 'unknown') {
      return null
    }
    return {
      operationContext,
      sourceOwner,
      worktreeRoot: operationContext.worktreePath ?? indexedRoot
    }
  } catch {
    return null
  }
}
