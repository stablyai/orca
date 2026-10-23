import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_FILE_EVENT,
  type EditorSaveAndCloseDetail,
  type EditorSaveFileDetail,
  type EditorSaveQuiesceDetail
} from './editor-autosave'
import { editorFileHoldKey, pathMutationHoldKeys } from './editor-autosave-holds'
import type { OpenFile } from '@/store/slices/editor'
import { flushPendingEditorBuffer } from './editor-pending-flush'
import {
  autosaveSubscriberInputsEqual,
  getAutosaveSubscriberInputs
} from './editor-autosave-state-projections'
import { createEditorSaveQueue, type AppStoreApi } from './editor-save-queue'
import { EDITOR_STALE_SAVE_MESSAGE } from './editor-save-disk-precondition'
import { createEditorRestartSaveHandlers } from './editor-restart-save-handlers'
import { createEditorExternalChangeTabReset } from './editor-external-change-tab-reset'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT
} from '../../../../shared/editor-save-events'

const NOT_SAVED_MESSAGE = "The file wasn't saved. Try saving again."

export function attachEditorAutosaveController(store: AppStoreApi): () => void {
  const saveQueue = createEditorSaveQueue(store)
  const {
    queueSave,
    quiesceFileSave,
    clearAutoSaveTimer,
    bumpSaveGeneration,
    holdAutoSave,
    syncAutoSave
  } = saveQueue

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
    if (!(event instanceof CustomEvent)) {
      return
    }
    const { fileId, onNotClosed }: EditorSaveAndCloseDetail = event.detail
    const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)
    if (!file) {
      return
    }

    flushPendingEditorBuffer(store.getState(), file.id)
    const draft = store.getState().editorDrafts[fileId]
    if (draft !== undefined) {
      try {
        // Why: only a written save may close the tab; anything else keeps it and its edits.
        const result = await queueSave(file, draft)
        if (result !== 'written') {
          onNotClosed?.(result === 'blocked-stale' ? 'blocked-stale' : 'not-saved')
          return
        }
      } catch {
        onNotClosed?.('not-saved')
        return
      }
    }
    store.getState().closeFile(fileId)
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

      flushPendingEditorBuffer(store.getState(), file.id)

      const content = store.getState().editorDrafts[file.id] ?? detail.fallbackContent
      if (content === undefined) {
        detail.resolve()
        return
      }

      const result = await queueSave(file, content, detail.overwrite ? 'overwrite' : 'user')
      if (result !== 'written') {
        detail.reject(result === 'blocked-stale' ? EDITOR_STALE_SAVE_MESSAGE : NOT_SAVED_MESSAGE)
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

    let release: (() => void) | undefined
    try {
      const state = store.getState()
      let matchingFiles: OpenFile[]
      if ('fileId' in detail) {
        matchingFiles = state.openFiles.filter((file) => file.id === detail.fileId)
      } else {
        // Why: a git discard rewrites the file under every workspace showing it, and the guarded
        // write's compare fallback (older hosts) can't refuse a save that read disk just before git.
        const keys = pathMutationHoldKeys(state, detail)
        release = holdAutoSave(keys)
        matchingFiles = state.openFiles.filter((file) => keys.has(editorFileHoldKey(state, file)))
      }
      await Promise.all(matchingFiles.map((file) => quiesceFileSave(file.id)))
    } catch (error) {
      // Why: a failed quiesce (e.g. an unresolved CSV cell) must stop the discard, not strand its hold.
      release?.()
      detail.reject?.(error instanceof Error ? error.message : String(error))
      return
    }
    if (release) {
      detail.onHold?.(release)
    }
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
