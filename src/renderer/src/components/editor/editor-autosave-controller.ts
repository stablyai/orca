import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_FILE_EVENT,
  type EditorSaveAndCloseDetail,
  type EditorSaveAndCloseOutcome,
  type EditorSaveFileDetail,
  type EditorSaveQuiesceDetail
} from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import { flushEditorBufferViews } from './editor-buffer-flush'
import {
  autosaveSubscriberInputsEqual,
  getAutosaveSubscriberInputs
} from './editor-autosave-state-projections'
import { createEditorSaveQueue, type AppStoreApi } from './editor-save-queue'
import { createEditorRestartSaveHandlers } from './editor-restart-save-handlers'
import { createEditorExternalChangeTabReset } from './editor-external-change-tab-reset'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT
} from '../../../../shared/editor-save-events'

const STALE_SAVE_MESSAGE =
  'This file changed on disk since your edits. Review the banner, then save again to overwrite.'

const NOT_SAVED_MESSAGE = "The file wasn't saved. Try saving again."

export function attachEditorAutosaveController(store: AppStoreApi): () => void {
  const saveQueue = createEditorSaveQueue(store)
  const { queueSave, quiesceFileSave, clearAutoSaveTimer, bumpSaveGeneration, syncAutoSave } =
    saveQueue

  const { handleSaveDirtyFiles, handlePrepareHotExit } = createEditorRestartSaveHandlers({
    store,
    queueSave,
    quiesceFileSave
  })

  const handleExternalFileChange = createEditorExternalChangeTabReset({
    store,
    clearAutoSaveTimer,
    bumpSaveGeneration
  })

  const handleSaveAndClose = async (event: Event): Promise<void> => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registered only for ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, which is dispatched with this detail.
    const { fileId, onSettled } = (event as CustomEvent<EditorSaveAndCloseDetail>).detail
    const settle = (outcome: EditorSaveAndCloseOutcome): void => onSettled?.(outcome)
    const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)
    if (!file) {
      settle('closed')
      return
    }

    flushPendingEditorChange(file.id)
    const draft = store.getState().editorDrafts[fileId]
    if (draft !== undefined) {
      try {
        // Why: only a written save may close the tab; anything else keeps it and its edits.
        if ((await queueSave(file, draft)) !== 'written') {
          settle('not-saved')
          return
        }
      } catch {
        settle('not-saved')
        return
      }
    }
    // Why: a sibling tab of the file may have typed (and closed) while this save ran; those
    // newer edits now live only here, so the tab stays open to save them.
    flushEditorBufferViews(store.getState, fileId)
    if (store.getState().openFiles.find((openFile) => openFile.id === fileId)?.isDirty) {
      settle('kept-open')
      return
    }
    store.getState().closeFile(fileId)
    settle('closed')
  }

  const handleSaveFile = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveFileDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()
      const file = store.getState().openFiles.find((openFile) => openFile.id === detail.fileId)
      if (!file) {
        detail.resolve()
        return
      }
      if (file.pendingOwnerMigration === true) {
        detail.reject('This file is still restoring its workspace owner. Try saving again.')
        return
      }

      flushPendingEditorChange(file.id)

      const content = store.getState().editorDrafts[file.id] ?? detail.fallbackContent
      if (content === undefined) {
        detail.resolve()
        return
      }

      const result = await queueSave(file, content)
      if (result !== 'written') {
        detail.reject(result === 'blocked-stale' ? STALE_SAVE_MESSAGE : NOT_SAVED_MESSAGE)
        return
      }
      detail.resolve()
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
    }
  }

  const handleQuiesce = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveQuiesceDetail>).detail
    if (!detail) {
      return
    }
    detail.claim()

    const matchingFiles =
      'fileId' in detail
        ? store.getState().openFiles.filter((file) => file.id === detail.fileId)
        : getOpenFilesForExternalFileChange(store.getState().openFiles, detail)

    await Promise.all(matchingFiles.map((file) => quiesceFileSave(file.id)))
    detail.resolve()
  }

  // Why: the root subscriber fires on every store tick; skip the scan unless the four autosave inputs changed.
  let previousAutosaveInputs = getAutosaveSubscriberInputs(store.getState())
  const unsubscribe = store.subscribe(() => {
    const nextAutosaveInputs = getAutosaveSubscriberInputs(store.getState())
    if (autosaveSubscriberInputsEqual(previousAutosaveInputs, nextAutosaveInputs)) {
      return
    }
    previousAutosaveInputs = nextAutosaveInputs
    syncAutoSave()
  })
  syncAutoSave()

  window.addEventListener(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, handleSaveDirtyFiles as EventListener)
  window.addEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, handlePrepareHotExit as EventListener)
  window.addEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, handleSaveAndClose as EventListener)
  window.addEventListener(ORCA_EDITOR_SAVE_FILE_EVENT, handleSaveFile as EventListener)
  window.addEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handleQuiesce as EventListener)
  window.addEventListener(
    ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
    handleExternalFileChange as EventListener
  )

  return () => {
    unsubscribe()
    window.removeEventListener(
      ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
      handleSaveDirtyFiles as EventListener
    )
    window.removeEventListener(
      ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
      handlePrepareHotExit as EventListener
    )
    window.removeEventListener(
      ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
      handleSaveAndClose as EventListener
    )
    window.removeEventListener(ORCA_EDITOR_SAVE_FILE_EVENT, handleSaveFile as EventListener)
    window.removeEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handleQuiesce as EventListener)
    window.removeEventListener(
      ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
      handleExternalFileChange as EventListener
    )
    saveQueue.dispose()
  }
}
