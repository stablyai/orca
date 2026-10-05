import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { OpenFile } from '../store/slices/editor'
import { canRecoverEditorBuffer } from './editor-recovery-metadata'
import { getEditorRecoveryCheckpoint } from './editor-recovery-checkpoints'

/** Keep compatibility snapshots for writable buffers, including edited unstaged diffs. */
export function buildEditorSessionData(
  openFiles: OpenFile[],
  editorDrafts: Record<string, string>,
  markdownFrontmatterVisible: Record<string, boolean>,
  activeFileIdByWorktree: Record<string, string | null>,
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
): Pick<
  WorkspaceSessionState,
  | 'openFilesByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'markdownFrontmatterVisible'
> {
  const editFiles = openFiles.filter(
    (f) =>
      f.mode === 'edit' ||
      (canRecoverEditorBuffer(f) && f.isDirty && editorDrafts[f.id] !== undefined)
  )
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
    const dirtyDraftContent = f.isDirty && f.readOnly !== true ? editorDrafts[f.id] : undefined
    const checkpoint = getEditorRecoveryCheckpoint(f.id)
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined,
      runtimeEnvironmentId: f.runtimeEnvironmentId,
      externalSshTargetId: f.externalSshTargetId,
      // Why: persist readOnly only when true; absence is the writable default on restore.
      ...(f.readOnly === true ? { readOnly: true } : {}),
      ...(f.readOnly === true && f.liveTail === true ? { liveTail: true } : {}),
      ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
      ...(dirtyDraftContent !== undefined
        ? {
            recoveryId: checkpoint?.id ?? f.recoveryId,
            recoveryRevision: checkpoint
              ? checkpoint.revision > 0
                ? checkpoint.revision
                : undefined
              : f.recoveryRevision,
            recoveryBufferKind:
              f.recoveryBufferKind ??
              checkpoint?.bufferKind ??
              (f.mode === 'diff' ? 'diff' : 'edit')
          }
        : {}),
      // Why: baseline travels with the draft so restore can detect a changed-on-disk conflict before autosave clobbers an offline agent write.
      ...(dirtyDraftContent !== undefined && f.lastKnownDiskSignature
        ? { lastKnownDiskSignature: f.lastKnownDiskSignature }
        : {})
    })
    const ids =
      editFileIdsByWorktree[f.worktreeId] ?? (editFileIdsByWorktree[f.worktreeId] = new Set())
    ids.add(f.id)
  }

  const activeFileEntries: [string, string][] = []
  for (const [worktreeId, fileId] of Object.entries(activeFileIdByWorktree)) {
    if (!fileId) {
      continue
    }
    if (editFileIdsByWorktree[worktreeId]?.has(fileId)) {
      activeFileEntries.push([worktreeId, fileId])
    }
  }
  const persistedActiveFileIdByWorktree: Record<string, string> =
    Object.fromEntries(activeFileEntries)

  const activeTabTypeEntries: [string, WorkspaceVisibleTabType][] = []
  for (const [worktreeId, tabType] of Object.entries(activeTabTypeByWorktree)) {
    if (tabType !== 'editor') {
      activeTabTypeEntries.push([worktreeId, tabType])
      continue
    }
    // Why: only keep the "editor" marker when it points at a restored file, else startup has no real editor tab to select.
    if (persistedActiveFileIdByWorktree[worktreeId]) {
      activeTabTypeEntries.push([worktreeId, tabType])
    }
  }
  const persistedActiveTabTypeByWorktree: Record<string, WorkspaceVisibleTabType> =
    Object.fromEntries(activeTabTypeEntries)
  const allEditFileIds = new Set(Object.values(editFileIdsByWorktree).flatMap((ids) => [...ids]))
  // Why: preserve the value so per-file hide overrides survive restart (map only carries `false`; visible is the default).
  const persistedMarkdownFrontmatterVisible = Object.fromEntries(
    Object.entries(markdownFrontmatterVisible ?? {}).filter(([fileId]) =>
      allEditFileIds.has(fileId)
    )
  )

  return {
    openFilesByWorktree: byWorktree,
    activeFileIdByWorktree: persistedActiveFileIdByWorktree,
    activeTabTypeByWorktree: persistedActiveTabTypeByWorktree,
    markdownFrontmatterVisible: persistedMarkdownFrontmatterVisible
  }
}
