import { getPersistedEditorOwnerFields } from './editor-file-operation-owner'
import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'
import type { ClosedEditorTabSnapshot } from '../store/slices/editor/types/open-file'

export function buildPersistedRecoveredEditorDrafts(
  snapshotsByWorktree: Record<string, ClosedEditorTabSnapshot[]> | undefined
): Record<string, PersistedOpenFile[]> {
  const archive: Record<string, PersistedOpenFile[]> = {}
  for (const [worktreeId, snapshots] of Object.entries(snapshotsByWorktree ?? {})) {
    const drafts = snapshots.filter(
      (snapshot) => snapshot.dirtyDraftContent !== undefined && snapshot.readOnly !== true
    )
    if (drafts.length === 0) {
      continue
    }
    archive[worktreeId] = drafts.map((snapshot) => ({
      filePath: snapshot.filePath,
      relativePath: snapshot.relativePath,
      worktreeId,
      language: snapshot.language,
      isPreview: false,
      ...getPersistedEditorOwnerFields(snapshot),
      dirtyDraftContent: snapshot.dirtyDraftContent,
      lastKnownDiskSignature: snapshot.lastKnownDiskSignature
    }))
  }
  return archive
}
