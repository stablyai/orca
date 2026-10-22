import { useAppStore, type AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { isEditorContentUnchanged } from './editor-content-dirty-state'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import type { FileContent } from './editor-panel-content-types'
import {
  editorModelSiblingTabs,
  isEditorModelDirty,
  setEditorDiskBaseline
} from './editor-save-disk-precondition'
import { setModelExternalMutation } from './editor-save-rebaseline'
import { notifyEditorFileCacheStale } from './editor-autosave'

/** `tab` is the pre-load snapshot, so its baseline is the version the draft was typed over. */
function clearDraftUnlessWhitespaceOnly(state: AppState, tab: OpenFile, diskContent: string): void {
  const draft = state.editorDrafts[tab.id]
  if (
    draft !== undefined &&
    draft !== diskContent &&
    // Why: if disk moved at all (even whitespace), keeping the draft would undo an outside change.
    tab.lastKnownDiskSignature === getDiskBaselineSignature(diskContent) &&
    tab.language === 'markdown' &&
    isEditorContentUnchanged(draft, diskContent, true)
  ) {
    return
  }
  state.clearEditorDraft(tab.id)
}

// Why: a clean load re-baselines what this tab's future edits are based on; a
// dirty tab keeps its baseline (its draft still derives from the older content
// the signature was taken over). Best-effort metadata — a failure here must
// not convert an already-delivered load into an error view, hence the guard.
export function stampCleanTabDiskBaseline(id: string, result: FileContent): void {
  if (result.isBinary || result.loadError || result.csvPreview) {
    return
  }
  try {
    const state = useAppStore.getState()
    const loadedFile = state.openFiles.find((file) => file.id === id)
    if (loadedFile && isEditorModelDirty(state, loadedFile)) {
      // Why: while any tab of the model holds unsaved text, that text's base stays the baseline;
      // a tab joining the model takes it, and a disk read that differs is a real external change.
      const modelBaseline = editorModelSiblingTabs(state, loadedFile).find(
        (tab) => tab.lastKnownDiskSignature !== undefined
      )?.lastKnownDiskSignature
      if (modelBaseline !== undefined) {
        setEditorDiskBaseline(state, id, modelBaseline)
        if (getDiskBaselineSignature(result.content) !== modelBaseline) {
          setModelExternalMutation(state, id, 'changed')
        }
      }
      return
    }
    if (loadedFile) {
      const moved = setEditorDiskBaseline(state, id, getDiskBaselineSignature(result.content))
      // Why: the model is clean, so any draft left on its tabs is stale text from an older version,
      // except a Markdown draft that differs from this disk text only in trailing whitespace.
      clearDraftUnlessWhitespaceOnly(state, loadedFile, result.content)
      for (const tab of moved) {
        clearDraftUnlessWhitespaceOnly(state, tab, result.content)
        notifyEditorFileCacheStale(tab.id)
      }
    }
  } catch (err) {
    console.warn('[editor] failed to stamp disk baseline', err)
  }
}
