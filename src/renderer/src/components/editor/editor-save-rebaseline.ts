import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import { notifyEditorFileCacheStale } from './editor-autosave'
import {
  editorModelSiblingTabs,
  noteEditorBaselineWrite,
  setEditorDiskBaseline,
  waitForEditorBaselineRestamp
} from './editor-save-disk-precondition'

/** Conflict state describes the shared text, so it applies to every tab showing that model. */
export function setModelExternalMutation(
  state: AppState,
  fileId: string,
  mutation: NonNullable<OpenFile['externalMutation']> | null
): void {
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  for (const tab of file ? editorModelSiblingTabs(state, file) : []) {
    state.setExternalMutation(tab.id, mutation)
  }
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
  // Why: while any tab still has edits beyond this write, the model holds them; a sibling must
  // show that, not disk. The saving tab's own written draft is about to be settled.
  const draft = state.editorDrafts[fileId]
  const modelDirty =
    (draft !== undefined && draft !== content) ||
    (file
      ? editorModelSiblingTabs(state, file).some((tab) => tab.id !== fileId && tab.isDirty)
      : false)
  for (const sibling of moved) {
    noteEditorBaselineWrite(sibling.id)
    if (sibling.externalMutation === 'changed') {
      state.setExternalMutation(sibling.id, null)
    }
    if (!modelDirty && state.editorDrafts[sibling.id] === undefined) {
      notifyEditorFileCacheStale(sibling.id)
    }
  }
}
