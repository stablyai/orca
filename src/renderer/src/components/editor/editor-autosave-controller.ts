import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_FILE_EVENT,
  type EditorSaveFileDetail,
  type EditorSaveAndCloseResult,
  type EditorSaveQuiesceDetail
} from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
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

export function attachEditorAutosaveController(store: AppStoreApi): () => void {
  let active = true
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

  const handleSaveAndClose = (event: Event): void => {
    if (!(event instanceof CustomEvent) || typeof event.detail?.fileId !== 'string') {
      return
    }
    const { fileId, claim, resolve } = event.detail
    if (typeof claim === 'function') {
      claim()
    }
    const complete = (result: EditorSaveAndCloseResult): void => {
      if (typeof resolve === 'function') {
        resolve(result)
      }
    }
    const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)
    if (!file) {
      complete('closed')
      return
    }
    const { operationProvenance, filePath, worktreeId, runtimeEnvironmentId } = file
    const externalSshTargetId = file.externalSshTargetId?.trim() || null
    const tabIds = new Set(
      (store.getState().unifiedTabsByWorktree?.[worktreeId] ?? [])
        .filter((tab) => tab.entityId === fileId)
        .map((tab) => tab.id)
    )
    let ownerProvenance = operationProvenance
    let queued = false
    const hasCloseAuthority = (): boolean => {
      if (!active) {
        return false
      }
      const state = store.getState()
      const currentFile = state.openFiles.find((openFile) => openFile.id === fileId)
      if (!queued || !currentFile) {
        return true
      }
      if (
        !ownerProvenance ||
        currentFile.operationProvenance !== operationProvenance ||
        currentFile.filePath !== filePath ||
        currentFile.worktreeId !== worktreeId ||
        (currentFile.externalSshTargetId?.trim() || null) !== externalSshTargetId ||
        (currentFile.runtimeEnvironmentId?.trim() || null) !==
          (runtimeEnvironmentId?.trim() || null) ||
        !(state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
          (tab) => tab.entityId === fileId && tabIds.has(tab.id)
        )
      ) {
        return false
      }
      try {
        assertEditorFileOperationCurrent(state, worktreeId, ownerProvenance)
        return true
      } catch {
        return false
      }
    }
    const closeAfterSave = (): void => {
      try {
        if (!hasCloseAuthority()) {
          complete('retained')
          return
        }
        flushPendingEditorChange(fileId)
        const state = store.getState()
        const currentFile = state.openFiles.find((openFile) => openFile.id === fileId)
        if (
          !hasCloseAuthority() ||
          (currentFile && (currentFile.isDirty || state.editorDrafts[fileId] !== undefined))
        ) {
          complete('retained')
          return
        }
        if (currentFile) {
          state.closeFile(fileId)
        }
        complete('closed')
      } catch {
        complete('failed')
      }
    }

    try {
      flushPendingEditorChange(fileId)
      const draft = store.getState().editorDrafts[fileId]
      if (draft !== undefined) {
        ownerProvenance ??= captureEditorFileOperationProvenance(
          store.getState(),
          worktreeId,
          runtimeEnvironmentId,
          runtimeEnvironmentId !== undefined
        )
        queued = true
        void queueSave(file, draft).then(closeAfterSave, () => complete('failed'))
      } else {
        closeAfterSave()
      }
    } catch {
      complete('failed')
    }
  }

  const handleSaveFile = (event: Event): void => {
    const detail = (event as CustomEvent<EditorSaveFileDetail>).detail
    if (!detail) {
      return
    }
    const { fileId, resolve, reject } = detail

    try {
      detail.claim()
      const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)
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

      void queueSave(file, content).then(resolve, (error: unknown) => {
        reject(error instanceof Error ? error.message : String(error))
      })
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
    active = false
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
