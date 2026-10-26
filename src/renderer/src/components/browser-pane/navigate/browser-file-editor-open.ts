import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import { getRelativePathInsideRoot } from '@/lib/path'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { toast } from 'sonner'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { openDocPreviewSource } from '../workspace-doc/doc-preview-document-actions'

/** file:// names this computer’s disk; a remote workspace editor would read the same path on another host. */
export function canOpenBrowserFileInWorkspaceEditor(state: AppState, worktreeId: string): boolean {
  return (
    getConnectionIdFromState(state, worktreeId) === null &&
    getRuntimeTargetForWorktreeOwner(state, worktreeId)?.kind === 'local'
  )
}

export async function openBrowserFileSource(worktreeId: string, filePath: string): Promise<void> {
  const state = useAppStore.getState()
  if (!canOpenBrowserFileInWorkspaceEditor(state, worktreeId)) {
    return
  }
  const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
  try {
    const stat = await statUserOpenedPath(
      { target: { kind: 'local' }, worktreeId, worktreePath: worktreeRoot },
      filePath
    )
    if (
      stat.isDirectory ||
      !canOpenBrowserFileInWorkspaceEditor(useAppStore.getState(), worktreeId)
    ) {
      return
    }
    openDocPreviewSource({
      filePath,
      relativePath: stat.escapesWorktree
        ? filePath
        : (getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath),
      worktreeId,
      runtimeEnvironmentId: null,
      externalSshTargetId: null
    })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
