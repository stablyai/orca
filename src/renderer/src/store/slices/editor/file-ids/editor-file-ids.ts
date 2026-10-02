import type { AppState } from '../../../types'
import type { EditorSlice } from '../types/editor-slice'
import type { DiffSource, EditorOpenTargetOptions, OpenFile } from '../types/open-file'
import { areLocalWindowsWslPathAliases } from '../../../../../../shared/cross-platform-path'
import { editorDocumentIdentityKey, runtimeOwnerKey } from './editor-document-identity'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'

export function isSameEditorOwner(
  file: Pick<OpenFile, 'worktreeId' | 'runtimeEnvironmentId'>,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    file.worktreeId === worktreeId &&
    runtimeOwnerKey(file.runtimeEnvironmentId) === runtimeOwnerKey(runtimeEnvironmentId)
  )
}

export function canReuseLocalWslAlias(
  state: AppState,
  existing: OpenFile,
  file: Pick<OpenFile, 'filePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId'>,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    isLocalWindowsDesktopClient() &&
    runtimeOwnerKey(runtimeEnvironmentId) === null &&
    !existing.externalSshTargetId?.trim() &&
    !file.externalSshTargetId?.trim() &&
    areLocalWindowsWslPathAliases(existing.filePath, file.filePath) &&
    getConnectionIdForFileFromState(state, file.worktreeId, file.filePath) === null &&
    getConnectionIdForFileFromState(state, existing.worktreeId, existing.filePath) === null
  )
}

export function buildOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId) ?? 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

export function buildDiffEditorFileId(
  worktreeId: string,
  diffSource: DiffSource,
  relativePath: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const legacyId = `${worktreeId}::diff::${diffSource}::${relativePath}`
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId)
  return runtimeKey
    ? `editor-diff:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(diffSource)}:${encodeURIComponent(relativePath)}`
    : legacyId
}

export function withDiffContentReloadRequest(file: OpenFile): OpenFile {
  return {
    ...file,
    diffContentReloadNonce: (file.diffContentReloadNonce ?? 0) + 1
  }
}

export function shouldRequestExistingFileContentReload(
  existing: OpenFile,
  nextMode: OpenFile['mode'],
  options: EditorOpenTargetOptions | undefined
): boolean {
  return (
    options?.forceContentReload === true &&
    !existing.isDirty &&
    (existing.mode === 'edit' || existing.mode === 'markdown-preview') &&
    (nextMode === 'edit' || nextMode === 'markdown-preview')
  )
}

export function isEditorFileIdOccupiedByOtherOwner(
  file: Pick<
    OpenFile,
    'id' | 'worktreeId' | 'runtimeEnvironmentId' | 'markdownPreviewSourceFileId'
  >,
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  if (isSameEditorOwner(file, worktreeId, runtimeEnvironmentId)) {
    return false
  }
  return file.id === filePath || file.markdownPreviewSourceFileId === filePath
}

export function matchesEditorMode(
  file: OpenFile,
  modes: readonly OpenFile['mode'][] | undefined
): boolean {
  return !modes || modes.includes(file.mode)
}

export function getReusableOpenFileModes(mode: OpenFile['mode']): readonly OpenFile['mode'][] {
  // Why: one path can be open as both a diff and an editable tab; matching by path alone would collapse them onto one OpenFile.
  return [mode]
}

/**
 * Every OpenFile that is the same edit document: one path, one owner. More than one record for
 * that identity is corruption, but until it is gone a close has to sweep all of them or the
 * survivors restore the tab on the next session write.
 *
 * Edit mode only: a path's diff variants all share `mode: 'diff'` and, for combined diffs, the
 * worktree path, so their identity lives in `diffSource` — and only edit records persist, so only
 * they can be duplicated by the session writer.
 */
export function collectSameDocumentOpenFileIds(
  openFiles: readonly OpenFile[],
  file: Pick<
    OpenFile,
    | 'id'
    | 'filePath'
    | 'worktreeId'
    | 'runtimeEnvironmentId'
    | 'externalSshTargetId'
    | 'readOnly'
    | 'liveTail'
    | 'mode'
  >
): Set<string> {
  const fileIds = new Set<string>([file.id])
  if (file.mode !== 'edit') {
    return fileIds
  }
  const identity = editorDocumentIdentityKey(file)
  const modes = getReusableOpenFileModes(file.mode)
  for (const candidate of openFiles) {
    if (matchesEditorMode(candidate, modes) && editorDocumentIdentityKey(candidate) === identity) {
      fileIds.add(candidate.id)
    }
  }
  return fileIds
}

export function resolveEditorFileIdForOwner(
  state: Pick<EditorSlice, 'openFiles'>,
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined,
  modes?: readonly OpenFile['mode'][]
): string {
  const existing = state.openFiles.find(
    (file) =>
      file.filePath === filePath &&
      matchesEditorMode(file, modes) &&
      isSameEditorOwner(file, worktreeId, runtimeEnvironmentId)
  )
  if (existing) {
    return existing.id
  }
  // Why: preview-only markdown tabs reserve their source id too; treat it like an open editor id so same-path owners don't collapse.
  return state.openFiles.some((file) =>
    isEditorFileIdOccupiedByOtherOwner(file, filePath, worktreeId, runtimeEnvironmentId)
  )
    ? buildOwnedEditorFileId(filePath, worktreeId, runtimeEnvironmentId)
    : filePath
}

export function getOpenedEditFileIdAfterOpen(
  state: Pick<EditorSlice, 'openFiles' | 'activeFileIdByWorktree'>,
  filePath: string,
  worktreeId: string
): string {
  const activeFileId = state.activeFileIdByWorktree[worktreeId]
  const activeFile = state.openFiles.find(
    (file) =>
      file.id === activeFileId &&
      file.filePath === filePath &&
      file.worktreeId === worktreeId &&
      file.mode === 'edit'
  )
  if (activeFile) {
    return activeFile.id
  }
  return (
    state.openFiles.find(
      (file) => file.filePath === filePath && file.worktreeId === worktreeId && file.mode === 'edit'
    )?.id ?? filePath
  )
}
