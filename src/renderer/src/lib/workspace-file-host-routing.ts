import { getConnectionId, getConnectionIdForFile } from '@/lib/connection-context'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { hasRemoteRuntimeOwner } from '@/runtime/runtime-file-routing'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'

/** Which host owns a workspace file, resolved the same way for every surface that opens one. */
export function buildWorkspaceFileContext(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId?: string | null
): RuntimeFileOperationArgs {
  return {
    target: requireRuntimeTargetForFileOwner(
      useAppStore.getState(),
      worktreeId,
      runtimeEnvironmentId
    ),
    worktreeId: worktreeId || null,
    worktreePath,
    connectionId: getConnectionId(worktreeId || null) ?? undefined
  }
}

/** Honor per-file ownership: folder workspaces may span hosts, making workspace owner undefined (downstream local) even when the file has a concrete remote owner. */
export function buildWorkspaceFileContextForFile(
  worktreeId: string,
  worktreePath: string,
  filePath: string,
  runtimeEnvironmentId?: string | null
): RuntimeFileOperationArgs {
  return {
    ...buildWorkspaceFileContext(worktreeId, worktreePath, runtimeEnvironmentId),
    connectionId: getConnectionIdForFile(worktreeId || null, filePath) ?? undefined
  }
}

/** Allow OS launches only for this client’s files; SSH/runtime files need downloading first. Ownership wins over path containment, including server files outside workspaces. */
export function canClientOsOpenWorkspaceFile(fileContext: RuntimeFileOperationArgs): boolean {
  return !fileContext.connectionId && !hasRemoteRuntimeOwner(fileContext)
}
