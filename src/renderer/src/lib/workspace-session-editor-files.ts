import type {
  PersistedOpenFile,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../shared/types'
import type { OpenFile } from '../store/slices/editor'

/** Build the editor-file portion of the workspace session for persistence.
 *  Only edit-mode files are saved — diffs and conflict views are transient. */
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
  const editFiles = openFiles.filter((f) => f.mode === 'edit')
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    // Why: read-only tabs never persist a dirty draft even if isDirty is
    // somehow set — restoring a draft would reintroduce writable/hot-exit state
    // for an agent-owned transcript.
    const dirtyDraftContent = f.isDirty && f.readOnly !== true ? editorDrafts[f.id] : undefined
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined,
      runtimeEnvironmentId: f.runtimeEnvironmentId,
      // Why: persist read-only only when true so pre-existing writable sessions
      // stay writable on restore (absence is the writable default).
      ...(f.readOnly === true ? { readOnly: true } : {}),
      ...(f.readOnly === true && f.liveTail === true ? { liveTail: true } : {}),
      ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
      // Why: the edit baseline travels with the dirty draft so a restore can
      // re-derive a changed-on-disk conflict before autosave may overwrite an
      // agent write that landed while the app was closed.
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
  const persistedActiveFileIdByWorktree = Object.fromEntries(activeFileEntries) as Record<
    string,
    string
  >

  const activeTabTypeEntries: [string, WorkspaceVisibleTabType][] = []
  for (const [worktreeId, tabType] of Object.entries(activeTabTypeByWorktree)) {
    if (tabType !== 'editor') {
      activeTabTypeEntries.push([worktreeId, tabType])
      continue
    }
    // Why: restart only restores edit-mode files. Persisting "editor" with a
    // transient diff/conflict file ID creates a session payload that cannot be
    // satisfied on startup and leaves the UI with no real editor tab to select.
    // Only keep the editor marker when it points at a restored file.
    if (persistedActiveFileIdByWorktree[worktreeId]) {
      activeTabTypeEntries.push([worktreeId, tabType])
    }
  }
  const persistedActiveTabTypeByWorktree = Object.fromEntries(activeTabTypeEntries) as Record<
    string,
    WorkspaceVisibleTabType
  >
  const allEditFileIds = new Set(Object.values(editFileIdsByWorktree).flatMap((ids) => [...ids]))
  // Why: preserve the actual value so per-file hide overrides survive restart;
  // the map only ever carries `false` entries (visible is the default).
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
