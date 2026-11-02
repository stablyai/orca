import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import { getRelativePathInsideRoot } from '@/lib/path'
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
export function openBrowserFileSource(worktreeId: string, filePath: string): void {
  const worktreeRoot = useAppStore.getState().getKnownWorktreeById(worktreeId)?.path ?? null
  openDocPreviewSource({
    filePath,
    relativePath: getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath,
    worktreeId,
    runtimeEnvironmentId: null,
    externalSshTargetId: null
  })
}
