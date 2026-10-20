import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorBufferIdOf } from '@/store/slices/editor/buffers/editor-buffer-record'
import { shouldPersistWorkspaceSession } from '@/lib/workspace-session'
import { canAutoSaveOpenFile } from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import { getDuplicateDirtySavePaths } from './editor-autosave-state-projections'
import type { AppStoreApi, EditorSaveQueue } from './editor-save-queue'
import type {
  EditorPrepareHotExitDetail,
  EditorSaveDirtyFilesDetail
} from '../../../../shared/editor-save-events'

// Why: tabs of one buffer record hold one draft, so save it once, through a tab that may write it.
function dirtyBufferWriters(state: AppState): OpenFile[] {
  const writers = new Map<string, OpenFile>()
  for (const file of state.openFiles) {
    if (!file.isDirty) {
      continue
    }
    const recordId = editorBufferIdOf(state, file.id)
    const current = writers.get(recordId)
    if (!current || (!canAutoSaveOpenFile(current) && canAutoSaveOpenFile(file))) {
      writers.set(recordId, file)
    }
  }
  return [...writers.values()]
}

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

  const handleSaveDirtyFiles = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveDirtyFilesDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()

      const dirtyFiles = dirtyBufferWriters(store.getState())
      const unsupportedDirtyFiles = dirtyFiles.filter((file) => !canAutoSaveOpenFile(file))
      if (unsupportedDirtyFiles.length > 0) {
        detail.reject('Some unsaved editor changes cannot be auto-saved before restart.')
        return
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
        return
      }

      const results = await Promise.all(
        dirtyFiles.map(async (file) => {
          const content = getLatestWritableContent(file)
          if (content === null) {
            throw new Error(`Missing editor buffer for ${file.relativePath}`)
          }
          return queueSave(file, content)
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
