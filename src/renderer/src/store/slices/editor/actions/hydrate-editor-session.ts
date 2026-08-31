import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { detectLanguage } from '@/lib/language-detect'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { OpenFile } from '../types/open-file'
import { buildValidWorktreeIdsForSessionHydration } from '../../degraded-repo-worktree-validity'
import { buildOwnedEditorFileId, isSameEditorOwner } from '../file-ids/editor-file-ids'
import {
  addEditorFileIdMigration,
  migrateEditorFileId,
  migrateHydratedEditorTabsAndGroups,
  resolveLegacyHydratedEditorFileId,
  shouldHydrateWithOwnedEditorFileId,
  type LegacyHydratedEditorFile
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
        const legacyHydratedOpenFiles: LegacyHydratedEditorFile[] = []
        const editorFileIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
        for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
          if (!validWorktreeIds.has(worktreeId)) {
            continue
          }
          for (const pf of files) {
            // Split tabs share one OpenFile; repeated records for the same owner are corruption.
            if (
              legacyHydratedOpenFiles.some(
                (file) =>
                  file.filePath === pf.filePath &&
                  isSameEditorOwner(file, worktreeId, pf.runtimeEnvironmentId)
              )
            ) {
              continue
            }
            const legacyId = resolveLegacyHydratedEditorFileId(
              legacyHydratedOpenFiles,
              pf,
              worktreeId
            )
            // Why: floating/runtime-owned files need IDs that survive peers disappearing between restarts; collision-based IDs drift when the path is no longer open elsewhere.
            const ownedId = buildOwnedEditorFileId(pf.filePath, worktreeId, pf.runtimeEnvironmentId)
            const id =
              shouldHydrateWithOwnedEditorFileId(worktreeId, pf.runtimeEnvironmentId) ||
              usedOpenFileIds.has(pf.filePath)
                ? ownedId
                : pf.filePath
            // Why: the persisted schema allows repeated (path, worktree, runtime) tuples, and an owned id repeats verbatim — restoring both would put two files under one id.
            if (usedOpenFileIds.has(id)) {
              continue
            }
            usedOpenFileIds.add(id)
            // Why: map from the collision-derived legacy id; keying by filePath would collapse same-path local/runtime tabs onto the last owner to hydrate.
            addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
            legacyHydratedOpenFiles.push({
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

        // Why: use the store's activeWorktreeId — hydrateWorkspaceSession may have nulled an invalid ID, and we must respect that.
        const activeWorktreeId = s.activeWorktreeId
        const fallbackActiveFileId = activeWorktreeId
          ? (openFiles.find((f) => f.worktreeId === activeWorktreeId)?.id ?? null)
          : null
        const persistedActiveFileId = activeWorktreeId
          ? migrateEditorFileId(
              editorFileIdMigrationsByWorktree,
              activeWorktreeId,
              persistedActiveFileIdByWorktree[activeWorktreeId]
            )
          : null
        // Why: the persisted active file may be gone (worktree validation or stale path), so verify it exists in the restored set.
        const activeFileExists = persistedActiveFileId
          ? openFiles.some(
              (f) => f.id === persistedActiveFileId && f.worktreeId === activeWorktreeId
            )
          : false
        // Why: the previous active surface may have been a transient diff/conflict tab (not restored), so promote the first restored edit file.
        const nextActiveFileId = activeFileExists ? persistedActiveFileId : fallbackActiveFileId
        const activeTabType: WorkspaceVisibleTabType =
          activeWorktreeId && persistedActiveTabTypeByWorktree[activeWorktreeId]
            ? persistedActiveTabTypeByWorktree[activeWorktreeId]
            : 'terminal'

        // Filter per-worktree maps to only valid worktrees with valid file references
        const filteredActiveFileIdByWorktree = Object.fromEntries(
          [...validWorktreeIds].flatMap((wId) => {
            const persistedFileId = migrateEditorFileId(
              editorFileIdMigrationsByWorktree,
              wId,
              persistedActiveFileIdByWorktree[wId]
            )
            if (
              persistedFileId &&
              openFiles.some((f) => f.id === persistedFileId && f.worktreeId === wId)
            ) {
              return [[wId, persistedFileId]]
            }
            const fallbackFileId = openFiles.find((f) => f.worktreeId === wId)?.id
            return fallbackFileId ? [[wId, fallbackFileId]] : []
          })
        )
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
        const openFileIds = new Set(openFiles.map((file) => file.id))
        // Why: visible is the default, so restore only per-file hide overrides (`false`); legacy `true` entries collapse to the default.
        const hiddenFrontmatterEntries = new Map<string, boolean>()
        for (const [persistedFileId, visible] of Object.entries(
          persistedMarkdownFrontmatterVisible
        )) {
          if (visible) {
            continue
          }
          if (openFileIds.has(persistedFileId)) {
            hiddenFrontmatterEntries.set(persistedFileId, false)
          }
          for (const migrations of Object.values(editorFileIdMigrationsByWorktree)) {
            const migratedFileId = migrations.get(persistedFileId)
            if (migratedFileId && openFileIds.has(migratedFileId)) {
              hiddenFrontmatterEntries.set(migratedFileId, false)
            }
          }
        }
        const markdownFrontmatterVisible = Object.fromEntries(hiddenFrontmatterEntries)

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
