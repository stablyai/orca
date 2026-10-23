import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import type { FileWriteDiskConflict } from '../../../../shared/file-write-disk-precondition'
import { notifyEditorFileCacheStale } from './editor-autosave'
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

/** Conflict state is a record field, so it reaches every view of the record. */
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

/**
 * After a write the model's one baseline moves to it. Tabs sharing the model show the written text
 * (it is their text), so their conflict mark clears and a clean one's cached copy is dropped.
 */
export function rebaselineAfterEditorWrite(state: AppState, fileId: string, content: string): void {
  // Why computed: the signature of what a UTF-8 write leaves on disk, with no extra stat.
  const moved = setEditorDiskBaseline(state, fileId, getWrittenContentDiskSignature(content))
  noteEditorBaselineWrite(fileId)
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (file) {
    // Why: disk now holds this UTF-8 write, so a non-UTF-8 pause no longer applies.
    resumeAutosaveForNonUtf8File(file)
  }
  // Why: views of one record share its draft. While it holds edits beyond this write, every view
  // must show them, not disk; the written draft itself is about to be settled.
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
