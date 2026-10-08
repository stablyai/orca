import type { AppState } from '../../../types'
import type { EditorSlice } from '../types/editor-slice'
import type { EditorOpenTargetOptions, OpenFile } from '../types/open-file'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host'
import { areLocalWindowsWslPathAliases } from '../../../../../../shared/cross-platform-path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import {
  buildDiffEditorFileId,
  buildOwnedEditorFileId,
  runtimeOwnerKey
} from '../../../../../../shared/editor-file-identity'

export { buildDiffEditorFileId, buildOwnedEditorFileId, runtimeOwnerKey }

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

export function mayShareEditorBackingFile(candidate: OpenFile, file: OpenFile): boolean {
  if (
    candidate.filePath !== file.filePath ||
    runtimeOwnerKey(candidate.runtimeEnvironmentId) !== runtimeOwnerKey(file.runtimeEnvironmentId)
  ) {
    return false
  }
  const candidateHost =
    candidate.operationProvenance?.generation.route.executionHostId ??
    (candidate.externalSshTargetId
      ? toSshExecutionHostId(candidate.externalSshTargetId)
      : undefined)
  const fileHost =
    file.operationProvenance?.generation.route.executionHostId ??
    (file.externalSshTargetId ? toSshExecutionHostId(file.externalSshTargetId) : undefined)
  // Missing provenance cannot prove that a retained view uses a different backing file.
  return !candidateHost || !fileHost || candidateHost === fileHost
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
