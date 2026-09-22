import type { OpenFile } from '@/store/slices/editor'
import { shouldPersistWorkspaceSession } from '@/lib/workspace-session'
import { canAutoSaveOpenFile } from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import { getDuplicateDirtySavePaths } from './editor-autosave-state-projections'
import type { AppStoreApi, EditorSaveQueue } from './editor-save-queue'
import type {
  EditorPrepareHotExitDetail,
  EditorSaveDirtyFilesDetail
} from '../../../../shared/editor-save-events'

type EditorRestartSaveHandlerOptions = {
  store: AppStoreApi
  queueSave: EditorSaveQueue['queueSave']
  quiesceFileSave: EditorSaveQueue['quiesceFileSave']
}

export function createEditorRestartSaveHandlers({
  store,
  queueSave,
  quiesceFileSave
}: EditorRestartSaveHandlerOptions): {
  handleSaveDirtyFiles: (event: Event) => Promise<void>
  handlePrepareHotExit: (event: Event) => Promise<void>
} {
  const getLatestWritableContent = (file: OpenFile): string | null => {
    // Why: headless controller reads editorDrafts rather than mounting the editor UI to read component-local buffers.
    return store.getState().editorDrafts[file.id] ?? null
  }

  const handleSaveDirtyFiles = (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveDirtyFilesDetail>).detail
    if (!detail) {
      return Promise.resolve()
    }
    const { resolve, reject } = detail

    try {
      detail.claim()

      const dirtyFiles = store.getState().openFiles.filter((file) => file.isDirty)
      const unsupportedDirtyFiles = dirtyFiles.filter((file) => !canAutoSaveOpenFile(file))
      if (unsupportedDirtyFiles.length > 0) {
        detail.reject('Some unsaved editor changes cannot be auto-saved before restart.')
        return Promise.resolve()
      }

      for (const file of dirtyFiles) {
        flushPendingEditorChange(file.id)
      }

      const duplicateDirtySavePaths = getDuplicateDirtySavePaths(dirtyFiles)
      if (duplicateDirtySavePaths.length > 0) {
        // Why: edit and diff tabs can share a path with different drafts; refuse rather than race an implicit winner.
        detail.reject(
          'Some unsaved files are open in multiple dirty tabs. Save them manually before restarting.'
        )
        return Promise.resolve()
      }

      return Promise.all(
        dirtyFiles.map((file) => {
          const content = getLatestWritableContent(file)
          if (content === null) {
            return Promise.reject(new Error(`Missing editor buffer for ${file.relativePath}`))
          }
          return queueSave(file, content)
        })
      ).then(resolve, (error: unknown) => {
        reject(error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
      return Promise.resolve()
    }
  }

  const handlePrepareHotExit = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorPrepareHotExitDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()

      const initiallyDirtyFiles = store.getState().openFiles.filter((file) => file.isDirty)
      await Promise.all(initiallyDirtyFiles.map((file) => quiesceFileSave(file.id)))

      const state = store.getState()
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

      // Why: preload dispatches beforeunload immediately after this resolves;
      // App owns the one combined session/UI checkpoint for restart and update.
      detail.resolve()
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
    }
  }

  return { handleSaveDirtyFiles, handlePrepareHotExit }
}
