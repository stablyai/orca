import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { detectLanguage } from '@/lib/language-detect'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import type { PersistedOpenFile } from '../../../../../../shared/workspace-session-state-types'
import type { ClosedEditorTabSnapshot, OpenFile } from '../types/open-file'
import {
  countRecoveredDraftsLostToCap,
  parkRecoveredEditorDrafts,
  type ParkedRecoveredEditorDrafts
} from './parked-recovered-editor-drafts'
import { buildValidWorktreeIdsForSessionHydration } from '../../degraded-repo-worktree-validity'
import { buildOwnedEditorFileId } from '../file-ids/editor-file-ids'
import { resolveHydratedEditorFileSelection } from '../file-ids/hydrated-editor-file-selection'
import { resolveHydratedEditorFrontmatter } from '../file-ids/hydrated-editor-frontmatter'
import {
  addEditorFileIdMigration,
  migrateHydratedEditorTabsAndGroups,
  LegacyHydratedEditorFileIndex,
  shouldHydrateWithOwnedEditorFileId
} from '../file-ids/hydrated-editor-file-ids'
import {
  alignHealedEditorTabHosts,
  planHealedPersistedEditorFiles,
  resolveHealableWorktreeOwnerRoute,
  type HealedEditorTabHostTarget
} from '../file-ids/hydrated-editor-owner-healing'
import {
  collectHydratedOrphanEditorFileIds,
  isOrphanEditorFile
} from '../file-ids/orphan-editor-file-ids'

/** A draft with no restorable identity of its own, parked where Mod+Shift+T can bring it back. */
function buildRecoveredDraftSnapshot(
  file: PersistedOpenFile,
  worktreeId: string
): ClosedEditorTabSnapshot {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId,
    language: detectLanguage(file.relativePath || file.filePath),
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    mode: 'edit',
    dirtyDraftContent: file.dirtyDraftContent,
    // Why: without the baseline the draft derives from, a reopen restores it with nothing for the
    // conflict scan to compare, and autosave can clobber an offline write.
    lastKnownDiskSignature: file.lastKnownDiskSignature
  }
}

function buildRecoveredDraftReopenState(
  state: Pick<AppState, 'recentlyClosedEditorTabsByWorktree' | 'recentlyClosedTabKindsByWorktree'>,
  recoveredByWorktree: Record<string, ClosedEditorTabSnapshot[]>
): Partial<
  Pick<AppState, 'recentlyClosedEditorTabsByWorktree' | 'recentlyClosedTabKindsByWorktree'>
> {
  const worktreeIds = Object.keys(recoveredByWorktree)
  if (worktreeIds.length === 0) {
    return {}
  }
  let parked: ParkedRecoveredEditorDrafts = {
    recentlyClosedEditorTabsByWorktree: state.recentlyClosedEditorTabsByWorktree,
    recentlyClosedTabKindsByWorktree: state.recentlyClosedTabKindsByWorktree
  }
  for (const worktreeId of worktreeIds) {
    parked = parkRecoveredEditorDrafts(parked, worktreeId, recoveredByWorktree[worktreeId])
  }
  return parked
}

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
        const legacyFileIndex = new LegacyHydratedEditorFileIndex()
        const editorFileIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
        const healedTabHostTargets: Record<string, HealedEditorTabHostTarget> = {}
        const recoveredDraftTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]> = {}
        for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
          if (!validWorktreeIds.has(worktreeId)) {
            continue
          }
          const route = resolveHealableWorktreeOwnerRoute(s, worktreeId)
          const healed = planHealedPersistedEditorFiles({
            files,
            worktreeId,
            route,
            persistedActiveFileId: persistedActiveFileIdByWorktree[worktreeId]
          })
          const parkRecoveredDraft = (draftFile: PersistedOpenFile): void => {
            const parked = (recoveredDraftTabsByWorktree[worktreeId] ??= [])
            parked.push(buildRecoveredDraftSnapshot(draftFile, worktreeId))
          }
          for (const draftFile of healed.recoverableDrafts) {
            parkRecoveredDraft(draftFile)
          }
          const healedFileIds = new Set<string>()
          for (const { file: pf, supersededIds, ownerNormalized } of healed.files) {
            // Split tabs share one OpenFile; repeated records for the same owner are corruption.
            if (legacyFileIndex.hasOwner(pf, worktreeId)) {
              // Why: a read-only and a writable row for one path resolve to the same owned id, so
              // this skip can land on the only copy of an unsaved draft. Read-only rows are exempt —
              // a reopen snapshot restores writable, which a log tab must never become.
              if (pf.dirtyDraftContent !== undefined && pf.readOnly !== true) {
                parkRecoveredDraft(pf)
              }
              continue
            }
            const legacyId = legacyFileIndex.resolve(pf, worktreeId)
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
            for (const supersededId of supersededIds) {
              addEditorFileIdMigration(
                editorFileIdMigrationsByWorktree,
                worktreeId,
                supersededId,
                id
              )
            }
            if (ownerNormalized) {
              healedFileIds.add(id)
            }
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
          if (route && healedFileIds.size > 0) {
            healedTabHostTargets[worktreeId] = { fileIds: healedFileIds, route }
          }
          // Why after the loop: drafts parked by the id-collision skip above are only known now.
          const parkedDraftCount = recoveredDraftTabsByWorktree[worktreeId]?.length ?? 0
          // Why reported: the reopen stack has a cap, and drafts past it are gone for good.
          const lostDraftCount = countRecoveredDraftsLostToCap(parkedDraftCount)
          if (
            healed.droppedCount > 0 ||
            healed.ownerRewrittenCount > 0 ||
            healed.divergentDraftGroupCount > 0 ||
            parkedDraftCount > 0
          ) {
            console.warn(
              `[editor-hydration] healed persisted editor state for ${worktreeId}: dropped ${healed.droppedCount} duplicate record(s), re-owned ${healed.ownerRewrittenCount}, kept ${healed.divergentDraftGroupCount} divergent-draft group(s) apart, ${parkedDraftCount - lostDraftCount} draft(s) moved to the reopen stack, ${lostDraftCount} lost to the reopen-stack cap`
            )
          }
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
        const migratedTabsAndGroups = migrateHydratedEditorTabsAndGroups(
          s,
          editorFileIdMigrationsByWorktree
        )
        // `?? {}` because an editor-only store (tests, partial slices) has no tab map at all.
        const migratedTabs =
          migratedTabsAndGroups.unifiedTabsByWorktree ?? s.unifiedTabsByWorktree ?? {}
        const healedTabs = alignHealedEditorTabHosts(migratedTabs, healedTabHostTargets)
        const nextTabsByWorktree = healedTabs ?? migratedTabs
        const orphanFileIdsByWorktree = collectHydratedOrphanEditorFileIds(
          openFiles,
          nextTabsByWorktree,
          filteredActiveFileIdByWorktree,
          editorDrafts
        )
        const survivingFiles =
          orphanFileIdsByWorktree.size > 0
            ? openFiles.filter((file) => !isOrphanEditorFile(orphanFileIdsByWorktree, file))
            : openFiles
        // Why by surviving id, not by orphan id: drafts and front-matter keys are keyed by id alone,
        // and an id orphaned in one worktree can still name a live document in another.
        const survivingFileIds = new Set(survivingFiles.map((file) => file.id))
        const markdownFrontmatterVisible = resolveHydratedEditorFrontmatter(
          persistedMarkdownFrontmatterVisible,
          survivingFileIds,
          editorFileIdMigrationsByWorktree
        )

        return {
          openFiles: survivingFiles,
          editorDrafts:
            survivingFiles.length === openFiles.length
              ? editorDrafts
              : Object.fromEntries(
                  Object.entries(editorDrafts).filter(([fileId]) => survivingFileIds.has(fileId))
                ),
          markdownFrontmatterVisible,
          activeFileId: nextActiveFileId,
          activeFileIdByWorktree: filteredActiveFileIdByWorktree,
          activeTabType: nextActiveTabType,
          activeTabTypeByWorktree: filteredActiveTabTypeByWorktree,
          ...migratedTabsAndGroups,
          ...(healedTabs ? { unifiedTabsByWorktree: healedTabs } : {}),
          ...buildRecoveredDraftReopenState(s, recoveredDraftTabsByWorktree)
        }
      })
    }
  }
}
