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
    // Any disk change, even whitespace, outranks a preserved draft based on older bytes.
    tab.lastKnownDiskSignature === getDiskBaselineSignature(diskContent) &&
    tab.language === 'markdown' &&
    isEditorContentUnchanged(draft, diskContent, true)
  ) {
    return
  }
  state.clearEditorDraft(tab.id)
}

// Clean loads advance baselines; dirty models keep their draft’s original base. Metadata failures must not turn a delivered load into an error.
export function stampCleanTabDiskBaseline(id: string, result: FileContent): void {
  if (result.isBinary || result.loadError || result.csvPreview) {
    return
  }
  try {
    const state = useAppStore.getState()
    const loadedFile = state.openFiles.find((file) => file.id === id)
    if (loadedFile && isEditorModelDirty(state, loadedFile)) {
      // Unsaved model text keeps its original baseline across joining views; differing disk reads indicate external changes.
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
      // Clean-model drafts are stale except Markdown trailing-whitespace differences against this exact disk version.
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
