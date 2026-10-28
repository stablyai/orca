import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { AppState } from '../../../types'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from '../types/open-file-path-rekey'
import { rekeyFileIdRecord } from '../file-ids/open-file-path-rekey'
import { rekeyEditorBuffers } from '../buffers/editor-buffer-record'
import { migrateHydratedEditorTabsAndGroups } from '../file-ids/hydrated-editor-file-ids'
import { renameEditorFilesThroughLayoutOwner } from '../tabs/editor-file-rename-through-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

// The store change is pure, so a layout-owner build applies it in the frame that shows main's rename.
export type RekeyOpenFilesPatch =
  | { ok: true; patch: Partial<AppState> }
  | Extract<RekeyOpenFilesResult, { ok: false }>

/** The rekey of `s`; refused as a whole when a source is gone or two files would share an id. */
export function rekeyOpenFilesPatch(
  s: AppState,
  rekeys: readonly OpenFilePathRekey[],
  moveOperationId: string | undefined
): RekeyOpenFilesPatch {
  const migrations = new Map<string, string>()
  const rekeyByOldId = new Map<string, OpenFilePathRekey>()
  for (const rekey of rekeys) {
    migrations.set(rekey.oldFileId, rekey.newFileId)
    rekeyByOldId.set(rekey.oldFileId, rekey)
  }
  const openById = new Map(s.openFiles.map((f) => [f.id, f]))

  // Preflight atomically: all sources open, unique targets and no target owned by unaffected sessions; never merge two.
  const seenNewIds = new Set<string>()
  for (const rekey of rekeys) {
    if (!openById.has(rekey.oldFileId)) {
      return { ok: false, reason: 'stale' }
    }
    if (seenNewIds.has(rekey.newFileId)) {
      return { ok: false, reason: 'collision' }
    }
    seenNewIds.add(rekey.newFileId)
    const occupier = openById.get(rekey.newFileId)
    if (occupier && !migrations.has(occupier.id)) {
      return { ok: false, reason: 'collision' }
    }
  }

  const nextOpenFiles = s.openFiles.map((f) => {
    const rekey = rekeyByOldId.get(f.id)
    if (!rekey) {
      return f
    }
    // Spread the whole OpenFile so fields this action doesn't know about survive; change only the path-derived ones.
    // Only a dirty autosave-capable tab needs its destination echo verified.
    const verifiesEcho =
      moveOperationId !== undefined &&
      f.isDirty &&
      // A 'changed' tab already shows the banner, which verification would only repeat.
      f.externalMutation !== 'changed' &&
      (f.mode === 'edit' || (f.mode === 'diff' && f.diffSource === 'unstaged'))
    return {
      ...f,
      id: rekey.newFileId,
      filePath: rekey.newFilePath,
      relativePath: rekey.newRelativePath,
      // After move, host snapshot IDs no longer match: detach host ownership to protect draft, and coordinator closes old-path host tab. In-place host rehome remains follow-up.
      mirroredFromRuntimeSession: undefined,
      ...(rekey.newLanguage !== undefined ? { language: rekey.newLanguage } : {}),
      ...(rekey.newMarkdownPreviewSourceFileId !== undefined
        ? { markdownPreviewSourceFileId: rekey.newMarkdownPreviewSourceFileId }
        : {}),
      ...(rekey.consumeUntitled
        ? { isUntitled: undefined, deleteUntouchedOnClose: undefined }
        : {}),
      ...(verifiesEcho
        ? {
            pendingSelfMoveEcho: {
              operationId: moveOperationId,
              targetPath: rekey.newFilePath
            }
          }
        : {})
    }
  })

  const activeFileIdByWorktree: Record<string, string | null> = {}
  for (const [wtId, activeId] of Object.entries(s.activeFileIdByWorktree)) {
    activeFileIdByWorktree[wtId] = activeId ? (migrations.get(activeId) ?? activeId) : activeId
  }

  // Partition by each file’s workspace; same paths can be open in multiple workspaces with independent tab/group state.
  const migrationsByWorktree: Record<string, Map<string, string>> = {}
  for (const rekey of rekeys) {
    const wtId = openById.get(rekey.oldFileId)!.worktreeId
    ;(migrationsByWorktree[wtId] ??= new Map()).set(rekey.oldFileId, rekey.newFileId)
  }

  const tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
  for (const [wtId, wtMigrations] of Object.entries(migrationsByWorktree)) {
    const prevBarOrder = tabBarOrderByWorktree[wtId]
    if (prevBarOrder) {
      tabBarOrderByWorktree[wtId] = prevBarOrder.map((id) => wtMigrations.get(id) ?? id)
    }
  }

  const reveal = s.pendingEditorReveal
  // Why: two worktrees can rekey the same oldFilePath, so an id-keyed reveal must match its own file, not the first path match.
  const rekeyForReveal = !reveal
    ? undefined
    : reveal.fileId
      ? rekeyByOldId.get(reveal.fileId)
      : rekeys.find((r) => r.oldFilePath === reveal.filePath)

  return {
    ok: true,
    patch: {
      openFiles: nextOpenFiles,
      ...rekeyEditorBuffers(s, s.openFiles, migrations, 'rename'),
      editorDrafts: rekeyFileIdRecord(s.editorDrafts, migrations),
      editorCursorLine: rekeyFileIdRecord(s.editorCursorLine, migrations),
      markdownViewMode: rekeyFileIdRecord(s.markdownViewMode, migrations),
      markdownRichModeSizeOverride: rekeyFileIdRecord(s.markdownRichModeSizeOverride, migrations),
      editorViewMode: rekeyFileIdRecord(s.editorViewMode, migrations),
      markdownFrontmatterVisible: rekeyFileIdRecord(s.markdownFrontmatterVisible, migrations),
      markdownTableOfContentsVisible: rekeyFileIdRecord(
        s.markdownTableOfContentsVisible,
        migrations
      ),
      activeFileId: s.activeFileId ? (migrations.get(s.activeFileId) ?? s.activeFileId) : null,
      activeFileIdByWorktree,
      tabBarOrderByWorktree,
      ...migrateHydratedEditorTabsAndGroups(s, migrationsByWorktree),
      ...(reveal && rekeyForReveal
        ? {
            pendingEditorReveal: {
              ...reveal,
              filePath: rekeyForReveal.newFilePath,
              // Migrate fileId too; pending reveals prefer it and otherwise never match moved tabs.
              ...(reveal.fileId ? { fileId: migrations.get(reveal.fileId) ?? reveal.fileId } : {})
            }
          }
        : {})
    }
  }
}

export function createRekeyOpenFilesAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'rekeyOpenFilesForPathChange'> {
  return {
    rekeyOpenFilesForPathChange: ({ rekeys, moveOperationId }) => {
      if (rekeys.length === 0) {
        return { ok: true }
      }
      // Switch point: main renames the tabs, and its frame rekeys the content.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return renameEditorFilesThroughLayoutOwner(
          set,
          get,
          rekeys,
          moveOperationId,
          rekeyOpenFilesPatch
        )
      }
      let result: RekeyOpenFilesResult = { ok: true }
      set((s) => {
        const next = rekeyOpenFilesPatch(s, rekeys, moveOperationId)
        if (!next.ok) {
          result = next
          return s
        }
        return next.patch
      })
      return result
    }
  }
}
