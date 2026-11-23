import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { shouldPersistWorkspaceSession } from '@/lib/workspace/persistence/workspace-session'
import { canAutoSaveOpenFile } from './editor-autosave'
import {
  flushEditorViewsForSave,
  flushPendingEditorBuffer,
  hasPendingEditorBufferChange
} from '../save/flush/editor-pending-flush'
import { getDuplicateDirtySavePaths, restartSaveTargets } from './editor-autosave-state-projections'
import type { AppStoreApi, EditorSaveQueue } from '../save/queue/editor-save-queue-contract'
import type {
  EditorPrepareHotExitDetail,
  EditorSaveDirtyFilesDetail
} from '../../../../../shared/editor/saving/editor-save-events'

type EditorRestartSaveHandlerOptions = {
  store: AppStoreApi
  queueSave: EditorSaveQueue['queueSave']
  settleFileSaves: EditorSaveQueue['settleFileSaves']
}

export function createEditorRestartSaveHandlers({
  store,
  queueSave,
  settleFileSaves
}: EditorRestartSaveHandlerOptions): {
  handleSaveDirtyFiles: (event: Event) => Promise<void>
  handlePrepareHotExit: (event: Event) => Promise<void>
} {
  const getLatestWritableContent = (file: OpenFile): string | null => {
    return store.getState().editorDrafts[file.id] ?? null
  }

  const handleSaveDirtyFiles = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveDirtyFilesDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()

      const dirtyFiles = restartSaveTargets(store.getState())
      const unsupportedDirtyFiles = dirtyFiles.filter((file) => !canAutoSaveOpenFile(file))
      if (unsupportedDirtyFiles.length > 0) {
        detail.reject('Some unsaved editor changes cannot be auto-saved before restart.')
        return
      }

      for (const file of dirtyFiles) {
        flushPendingEditorBuffer(store.getState(), file.id)
      }

      const duplicateDirtySavePaths = getDuplicateDirtySavePaths(dirtyFiles)
      if (duplicateDirtySavePaths.length > 0) {
        // Different dirty records can share a path; refuse restart rather than choose an implicit save winner.
        detail.reject(
          'Some unsaved files are open in multiple dirty tabs. Save them manually before restarting.'
        )
        return
      }

      const results = await Promise.all(
        dirtyFiles.map(async (file) => {
          const content = getLatestWritableContent(file)
          if (content === null) {
            throw new Error(`Missing editor buffer for ${file.relativePath}`)
          }
          return queueSave(file, content, 'restart')
        })
      )
      if (results.some((result) => result !== 'written')) {
        detail.reject('Some unsaved files were not saved. Review them before restarting.')
        return
      }
      detail.resolve()
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
    }
  }

  const handlePrepareHotExit = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorPrepareHotExitDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()

      const initialState = store.getState()
      const viewsByBuffer = new Map(
        initialState.openFiles.map((file) => [editorBufferIdOfView(initialState, file.id), file.id])
      )
      const flushed = await Promise.all(
        Array.from(viewsByBuffer.values(), (fileId) =>
          flushEditorViewsForSave(store.getState, fileId)
        )
      )
      if (flushed.some((result) => !result)) {
        detail.reject('An editor still has pending changes. Finish editing before restarting.')
        return
      }

      const initiallyDirtyFiles = store.getState().openFiles.filter((file) => file.isDirty)
      await Promise.all(initiallyDirtyFiles.map((file) => settleFileSaves(file.id, false)))

      const state = store.getState()
      if (state.openFiles.some((file) => hasPendingEditorBufferChange(state, file.id))) {
        detail.reject('An editor still has pending changes. Finish editing before restarting.')
        return
      }
      const dirtyFiles = state.openFiles.filter((file) => file.isDirty)
      const unsupportedDirtyFiles = dirtyFiles.filter((file) => file.mode !== 'edit')
      if (unsupportedDirtyFiles.length > 0) {
        detail.reject('Some unsaved editor changes cannot be backed up before restart.')
        return
      }

      for (const file of dirtyFiles) {
        if (state.editorDrafts[file.id] === undefined) {
          throw new Error(`Missing editor buffer for ${file.relativePath}`)
        }
      }

      if (dirtyFiles.length > 0 && !shouldPersistWorkspaceSession(state)) {
        detail.reject(
          'Unsaved editor changes cannot be backed up until workspace restore finishes.'
        )
        return
      }

      // Resolve only after saving; preload unloads immediately and App owns the combined restart/update checkpoint.
      detail.resolve()
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
    }
  }

  return { handleSaveDirtyFiles, handlePrepareHotExit }
}
