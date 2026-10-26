import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorBufferIdForFile } from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import type { FileWriteDiskConflict } from '../../../../shared/file-write-disk-precondition'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { hasPendingEditorBufferChange } from './editor-pending-flush'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import {
  pauseAutosaveForNonUtf8File,
  resumeAutosaveForNonUtf8File
} from './editor-non-utf8-autosave-pause'
import {
  editorModelSiblingTabs,
  noteEditorBaselineWrite,
  setEditorDiskBaseline,
  waitForEditorBaselineRestamp
} from './editor-save-disk-precondition'

export function setModelExternalMutation(
  state: AppState,
  fileId: string,
  mutation: NonNullable<OpenFile['externalMutation']> | null
): void {
  state.setExternalMutation(fileId, mutation)
}

/** The banner, deleted tombstone or non-UTF-8 notice explains a refused save and pauses autosave. */
export function markEditorSaveRefusal(
  state: AppState,
  file: OpenFile,
  diskConflict: FileWriteDiskConflict
): void {
  if (diskConflict === 'not-utf8') {
    pauseAutosaveForNonUtf8File(file)
    return
  }
  setModelExternalMutation(state, file.id, diskConflict === 'missing' ? 'deleted' : 'changed')
}

/** A Keep in any tab of this text restamps the baseline the save uses, so wait for all of them. */
export function waitForModelBaselineRestamps(state: AppState, file: OpenFile): Promise<unknown> {
  const tab = state.openFiles.find((openFile) => openFile.id === file.id)
  const tabs = tab ? editorModelSiblingTabs(state, tab) : [file]
  return Promise.all(tabs.map((sibling) => waitForEditorBaselineRestamp(sibling.id)))
}

/** Advance the shared baseline and clear conflicts; evict clean sibling caches unless the record holds newer edits. */
export function rebaselineAfterEditorWrite(state: AppState, fileId: string, content: string): void {
  // Match the bytes a UTF-8 write produces without an extra stat.
  const moved = setEditorDiskBaseline(state, fileId, getWrittenContentDiskSignature(content))
  noteEditorBaselineWrite(fileId)
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (file) {
    // The completed UTF-8 write ends any non-UTF-8 autosave pause.
    resumeAutosaveForNonUtf8File(file)
  }
  // Newer record edits must stay visible in every view instead of being replaced by disk text.
  const draft = state.editorDrafts[fileId]
  const recordDirty = draft !== undefined && draft !== content
  for (const sibling of moved) {
    noteEditorBaselineWrite(sibling.id)
    if (sibling.externalMutation === 'changed') {
      state.setExternalMutation(sibling.id, null)
    }
    if (!recordDirty) {
      notifyEditorFileCacheStale(sibling.id)
    }
  }
}

export function settleEditorRecordAfterWrite(
  getState: () => AppState,
  viewId: string,
  content: string
): void {
  rebaselineAfterEditorWrite(getState(), viewId, content)
  const state = getState()
  const currentDraft = state.editorDrafts[viewId]
  const stillDirty =
    (currentDraft !== undefined && currentDraft !== content) ||
    hasPendingEditorBufferChange(state, viewId)
  state.markFileDirty(viewId, stillDirty, { written: true })
  if (!stillDirty) {
    state.clearEditorDraft(viewId)
  }
  const savedFile = state.openFiles.find((openFile) => openFile.id === viewId)
  if (savedFile?.externalMutation === 'changed') {
    trackExternalChangeConflictAction(savedFile, 'save_overwrite')
    state.setExternalMutation(viewId, null)
  }
}

/** With no original views left, settle retained records and advance detached peers’ baselines without clearing their edits. */
export function settleEditorWriteWithoutViews(
  state: AppState,
  recordViewIds: readonly string[],
  identityKey: string,
  content: string
): void {
  const signature = getWrittenContentDiskSignature(content)
  state.settleKeptEditorBuffers(recordViewIds, content, signature)
  for (const peer of state.openFiles) {
    if (
      peer.lastKnownDiskSignature === signature ||
      editorBufferIdForFile(peer, state) !== identityKey
    ) {
      continue
    }
    state.setLastKnownDiskSignature(peer.id, signature)
    if (!peer.isDirty) {
      notifyEditorFileCacheStale(peer.id)
    }
  }
}
