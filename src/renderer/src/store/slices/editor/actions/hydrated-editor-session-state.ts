import { detectLanguage } from '@/lib/language-detect'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { reconcileEditorBufferMembership } from '../buffers/editor-buffer-record'
import { buildOwnedEditorFileId } from '../file-ids/editor-file-ids'
import { resolveHydratedEditorFileSelection } from '../file-ids/hydrated-editor-file-selection'
import { resolveHydratedEditorFrontmatter } from '../file-ids/hydrated-editor-frontmatter'
import {
  addEditorFileIdMigration,
  LegacyHydratedEditorFileIndex,
  shouldHydrateWithOwnedEditorFileId
} from '../file-ids/hydrated-editor-file-ids'

export type HydratedEditorSessionState = Pick<
  AppState,
  | 'openFiles'
  | 'editorBuffers'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
>

/**
 * The editor state a stored session restores, and the file id each workspace's tabs must be
 * rekeyed to. `activeWorktreeId` is the store's, which workspace hydration may have nulled.
 */
export function buildHydratedEditorSessionState(
  session: WorkspaceSessionState,
  validWorktreeIds: ReadonlySet<string>,
  activeWorktreeId: string | null
): {
  state: HydratedEditorSessionState
  editorFileIdMigrationsByWorktree: Record<string, Map<string, string>>
} {
  const openFilesByWorktree = session.openFilesByWorktree ?? {}
  const persistedActiveFileIdByWorktree = session.activeFileIdByWorktree ?? {}
  const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
  const persistedMarkdownFrontmatterVisible = session.markdownFrontmatterVisible ?? {}

  const openFiles: OpenFile[] = []
  const editorDrafts: Record<string, string> = {}
  const usedOpenFileIds = new Set<string>()
  const legacyFileIndex = new LegacyHydratedEditorFileIndex()
  const editorFileIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
  const tabEntityIdsByWorktree = new Map<string, ReadonlySet<string>>()
  const savedTabEntityIds = (worktreeId: string): ReadonlySet<string> => {
    let ids = tabEntityIdsByWorktree.get(worktreeId)
    if (!ids) {
      ids = new Set((session.unifiedTabs?.[worktreeId] ?? []).map((tab) => tab.entityId))
      tabEntityIdsByWorktree.set(worktreeId, ids)
    }
    return ids
  }
  for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    for (const pf of files) {
      // Split tabs share one OpenFile; repeated records for the same owner are corruption.
      if (legacyFileIndex.hasOwner(pf, worktreeId)) {
        continue
      }
      const legacyId = legacyFileIndex.resolve(pf, worktreeId)
      // Why: floating/runtime-owned files need IDs that survive peers disappearing between restarts; collision-based IDs drift when the path is no longer open elsewhere.
      const ownedId = buildOwnedEditorFileId(pf.filePath, worktreeId, pf.runtimeEnvironmentId)
      const id =
        shouldHydrateWithOwnedEditorFileId(worktreeId, pf.runtimeEnvironmentId) ||
        usedOpenFileIds.has(pf.filePath) ||
        // Why: a tab Orca moved to the workspace owning its file names it by its owned id (F42).
        savedTabEntityIds(worktreeId).has(ownedId)
          ? ownedId
          : pf.filePath
      // Why: the persisted schema allows repeated (path, worktree, runtime) tuples, and an owned id repeats verbatim — restoring both would put two files under one id.
      if (usedOpenFileIds.has(id)) {
        continue
      }
      usedOpenFileIds.add(id)
      // Why: map from the collision-derived legacy id; keying by filePath would collapse same-path local/runtime tabs onto the last owner to hydrate.
      addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
      legacyFileIndex.add({
        id: legacyId,
        filePath: pf.filePath,
        worktreeId,
        runtimeEnvironmentId: pf.runtimeEnvironmentId
      })
      // Why: read-only tabs (AI Vault View Log) must restore clean — ignore any persisted dirty draft/baseline so they can't come back writable.
      const isReadOnly = pf.readOnly === true
      if (!isReadOnly && pf.dirtyDraftContent !== undefined) {
        editorDrafts[id] = pf.dirtyDraftContent
      }
      openFiles.push({
        id,
        filePath: pf.filePath,
        relativePath: pf.relativePath,
        worktreeId,
        // Why: re-detect language on hydrate — older sessions stored ids from before extensions like .ipynb were supported.
        language: detectLanguage(pf.relativePath || pf.filePath),
        isDirty: !isReadOnly && pf.dirtyDraftContent !== undefined,
        isPreview: pf.isPreview,
        runtimeEnvironmentId: pf.runtimeEnvironmentId,
        externalSshTargetId: pf.externalSshTargetId,
        ...(isReadOnly ? { readOnly: true } : {}),
        ...(isReadOnly && pf.liveTail === true ? { liveTail: true } : {}),
        lastKnownDiskSignature: isReadOnly ? undefined : pf.lastKnownDiskSignature,
        // Why: suspend autosave until the conflict scan verifies disk vs baseline, else a slow remote read clobbers an offline write.
        pendingDiskBaselineVerification:
          !isReadOnly &&
          pf.dirtyDraftContent !== undefined &&
          pf.lastKnownDiskSignature !== undefined
            ? true
            : undefined,
        mode: 'edit'
      })
    }
  }

  const { activeFileId: nextActiveFileId, activeFileIdByWorktree: filteredActiveFileIdByWorktree } =
    resolveHydratedEditorFileSelection({
      openFiles,
      validWorktreeIds,
      activeWorktreeId,
      persistedActiveFileIds: persistedActiveFileIdByWorktree,
      migrations: editorFileIdMigrationsByWorktree
    })
  const activeTabType: WorkspaceVisibleTabType =
    activeWorktreeId && persistedActiveTabTypeByWorktree[activeWorktreeId]
      ? persistedActiveTabTypeByWorktree[activeWorktreeId]
      : 'terminal'

  const filteredActiveTabTypeByWorktree = Object.fromEntries(
    Object.entries(persistedActiveTabTypeByWorktree).filter(([wId, tabType]) => {
      if (!validWorktreeIds.has(wId)) {
        return false
      }
      if (tabType !== 'editor') {
        return true
      }
      // Why: an "editor" marker is valid only if the worktree restored a concrete active file; otherwise it's a stale marker.
      return Boolean(filteredActiveFileIdByWorktree[wId])
    })
  )

  // Why: transient diff/conflict surfaces aren't restored, so clear a stale "editor" marker and fall back to terminal.
  const nextActiveTabType =
    nextActiveFileId || activeTabType !== 'editor' ? activeTabType : 'terminal'
  const markdownFrontmatterVisible = resolveHydratedEditorFrontmatter(
    persistedMarkdownFrontmatterVisible,
    usedOpenFileIds,
    editorFileIdMigrationsByWorktree
  )

  return {
    state: {
      openFiles,
      // Why fresh: a restored tab's buffer state comes from the session, not a same-id tab it replaces.
      editorBuffers: reconcileEditorBufferMembership({}, openFiles),
      editorDrafts,
      markdownFrontmatterVisible,
      activeFileId: nextActiveFileId,
      activeFileIdByWorktree: filteredActiveFileIdByWorktree,
      activeTabType: nextActiveTabType,
      activeTabTypeByWorktree: filteredActiveTabTypeByWorktree
    },
    editorFileIdMigrationsByWorktree
  }
}
