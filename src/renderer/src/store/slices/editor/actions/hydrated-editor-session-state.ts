import { detectLanguage } from '@/lib/language-detect'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { reconcileEditorBufferMembership } from '../buffers/editor-buffer-record'
import { buildEditorBufferViewIndex } from '../buffers/editor-buffer-views'
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
  | 'editorBufferIdOf'
  | 'editorBufferViews'
  | 'editorBufferDetached'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
>

/** Restore editor state with per-workspace file rekeys; use current activeWorktreeId because workspace hydration may already have invalidated it. */
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
      // Floating/runtime IDs must survive peers disappearing; collision-derived IDs drift when other paths close.
      const ownedId = buildOwnedEditorFileId(pf.filePath, worktreeId, pf.runtimeEnvironmentId)
      const id =
        shouldHydrateWithOwnedEditorFileId(worktreeId, pf.runtimeEnvironmentId) ||
        usedOpenFileIds.has(pf.filePath) ||
        // Why: a tab Orca moved to the workspace owning its file names it by its owned id (F42).
        savedTabEntityIds(worktreeId).has(ownedId)
          ? ownedId
          : pf.filePath
      // Schema permits duplicate owner/path tuples; restore only one or owned IDs collide.
      if (usedOpenFileIds.has(id)) {
        continue
      }
      usedOpenFileIds.add(id)
      // Remap legacy collision-derived IDs, not paths; path keys collapse local/runtime twins onto the last owner.
      addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
      legacyFileIndex.add({
        id: legacyId,
        filePath: pf.filePath,
        worktreeId,
        runtimeEnvironmentId: pf.runtimeEnvironmentId
      })
      // Restore logs clean, ignoring persisted dirty/draft/baseline so read-only tabs cannot become writable.
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
        mirroredFromRuntimeSession: pf.mirroredFromRuntimeSession,
        externalSshTargetId: pf.externalSshTargetId,
        ...(isReadOnly ? { readOnly: true } : {}),
        ...(isReadOnly && pf.liveTail === true ? { liveTail: true } : {}),
        lastKnownDiskSignature: isReadOnly ? undefined : pf.lastKnownDiskSignature,
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

  // Why own records: the record middleware joins restored views once their identities resolve.
  const viewIndex = buildEditorBufferViewIndex(openFiles, (file) => file.id)
  return {
    state: {
      openFiles,
      // Why fresh: a restored tab's buffer state comes from the session, not a same-id tab it replaces.
      editorBuffers: reconcileEditorBufferMembership({}, openFiles, viewIndex),
      ...viewIndex,
      editorBufferDetached: {},
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
