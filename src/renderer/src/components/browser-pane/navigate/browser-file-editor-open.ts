import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import { getRelativePathInsideRoot } from '@/lib/path'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { toast } from 'sonner'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { openDocPreviewSource } from '../workspace-doc/doc-preview-document-actions'

/**
 * A local browser page's file:// URL names a file on this computer, so its source can open in the
 * editor only where this computer owns the workspace; elsewhere the editor would read the
 * workspace host's file at that path.
 */
export function canOpenBrowserFileInWorkspaceEditor(state: AppState, worktreeId: string): boolean {
  return (
    getConnectionIdFromState(state, worktreeId) === null &&
    getRuntimeTargetForWorktreeOwner(state, worktreeId)?.kind === 'local'
  )
}

/** Opens the file behind a local browser page as its editable source, as a document preview does. */
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
