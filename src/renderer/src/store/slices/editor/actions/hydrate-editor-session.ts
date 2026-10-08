import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { detectLanguage } from '@/lib/language-detect'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { OpenFile } from '../types/open-file'
import { buildValidWorktreeIdsForSessionHydration } from '../../degraded-repo-worktree-validity'
import { assignHydratedEditorFileIds } from '../../../../../../shared/editor-file-identity'
import { resolveHydratedEditorFileSelection } from '../file-ids/hydrated-editor-file-selection'
import { resolveHydratedEditorFrontmatter } from '../file-ids/hydrated-editor-frontmatter'
import {
  addEditorFileIdMigration,
  migrateHydratedEditorTabsAndGroups
} from '../file-ids/hydrated-editor-file-ids'

export function createHydrateEditorSession(
  set: EditorSet,
  _get: EditorGet
): Pick<EditorSlice, 'hydrateEditorSession'> {
  return {
    hydrateEditorSession: (session, options) => {
      set((s) => {
        const openFilesByWorktree = session.openFilesByWorktree ?? {}
        const persistedActiveFileIdByWorktree = session.activeFileIdByWorktree ?? {}
        const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
        const persistedMarkdownFrontmatterVisible = session.markdownFrontmatterVisible ?? {}

        const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
          s,
          Object.keys(openFilesByWorktree)
        )
        validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
        for (const workspace of s.folderWorkspaces) {
          validWorktreeIds.add(folderWorkspaceKey(workspace.id))
        }
        addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

        const openFiles: OpenFile[] = []
        const editorDrafts: Record<string, string> = {}
        const usedOpenFileIds = new Set<string>()
        const editorFileIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
        for (const { worktreeId, file: pf, legacyId, id } of assignHydratedEditorFileIds(
          openFilesByWorktree,
          (worktreeId) => validWorktreeIds.has(worktreeId)
        )) {
          usedOpenFileIds.add(id)
          // Why: map from the collision-derived legacy id; keying by filePath would collapse same-path local/runtime tabs onto the last owner to hydrate.
          addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
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

        // Why: use the store's activeWorktreeId — hydrateWorkspaceSession may have nulled an invalid ID, and we must respect that.
        const activeWorktreeId = s.activeWorktreeId
        const {
          activeFileId: nextActiveFileId,
          activeFileIdByWorktree: filteredActiveFileIdByWorktree
        } = resolveHydratedEditorFileSelection({
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
          openFiles,
          editorDrafts,
          markdownFrontmatterVisible,
          activeFileId: nextActiveFileId,
          activeFileIdByWorktree: filteredActiveFileIdByWorktree,
          activeTabType: nextActiveTabType,
          activeTabTypeByWorktree: filteredActiveTabTypeByWorktree,
          ...migrateHydratedEditorTabsAndGroups(s, editorFileIdMigrationsByWorktree)
        }
      })
    }
  }
}
