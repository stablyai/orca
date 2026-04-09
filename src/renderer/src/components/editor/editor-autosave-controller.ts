import type { StoreApi } from 'zustand'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_FILE_EVENT,
  type EditorFileSavedDetail,
  type EditorPathMutationTarget,
  type EditorSaveFileDetail,
  type EditorSaveQuiesceDetail
} from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import {
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
  type EditorSaveDirtyFilesDetail
} from '../../../../shared/editor-save-events'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

function getDuplicateDirtySavePaths(files: OpenFile[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    counts.set(file.filePath, (counts.get(file.filePath) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([filePath]) => filePath)
}

export function attachEditorAutosaveController(store: AppStoreApi): () => void {
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduledContent = new Map<string, string>()
  const saveQueue = new Map<string, Promise<void>>()
  const saveGeneration = new Map<string, number>()

  const clearAutoSaveTimer = (fileId: string): void => {
    const timerId = autoSaveTimers.get(fileId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
      autoSaveTimers.delete(fileId)
    }
    autoSaveScheduledContent.delete(fileId)
  }

  const bumpSaveGeneration = (fileId: string): void => {
    saveGeneration.set(fileId, (saveGeneration.get(fileId) ?? 0) + 1)
  }

  const queueSave = (file: OpenFile, fallbackContent: string): Promise<void> => {
    clearAutoSaveTimer(file.id)
    const queuedGeneration = saveGeneration.get(file.id) ?? 0

    const previousSave = saveQueue.get(file.id) ?? Promise.resolve()
    const queuedSave = previousSave
      .catch(() => undefined)
      .then(async () => {
        if ((saveGeneration.get(file.id) ?? 0) !== queuedGeneration) {
          return
        }

        const state = store.getState()
        const liveFile = state.openFiles.find((openFile) => openFile.id === file.id) ?? null
        if (!liveFile) {
          return
        }

        const contentToSave = state.editorDrafts[file.id] ?? fallbackContent
        await window.api.fs.writeFile({ filePath: liveFile.filePath, content: contentToSave })

        if ((saveGeneration.get(file.id) ?? 0) !== queuedGeneration) {
          return
        }

        const nextState = store.getState()
        const currentDraft = nextState.editorDrafts[file.id]
        const stillDirty = currentDraft !== undefined && currentDraft !== contentToSave
        nextState.markFileDirty(file.id, stillDirty)
        if (!stillDirty) {
          nextState.clearEditorDraft(file.id)
        }

        window.dispatchEvent(
          new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
            detail: { fileId: file.id, content: contentToSave }
          })
        )
      })

    let trackedSave: Promise<void>
    trackedSave = queuedSave.finally(() => {
      if (saveQueue.get(file.id) === trackedSave) {
        saveQueue.delete(file.id)
      }
    })
    saveQueue.set(file.id, trackedSave)
    return trackedSave
  }

  const quiesceFileSave = async (fileId: string): Promise<void> => {
    // Why: rich markdown debounces serialization for typing performance, so a
    // quiesce request must force any mounted editor to publish its pending
    // draft before we cancel timers for rename/delete/discard flows.
    flushPendingEditorChange(fileId)
    const pendingSave = saveQueue.get(fileId)
    clearAutoSaveTimer(fileId)
    bumpSaveGeneration(fileId)
    await pendingSave?.catch(() => undefined)
  }

  const getLatestWritableContent = (file: OpenFile): string | null => {
    // Why: only explicit user edits mark a tab dirty, and those edits are
    // mirrored into editorDrafts on each change. The headless autosave
    // controller deliberately depends on that narrow draft state instead of
    // keeping the full editor UI mounted just to read component-local buffers.
    return store.getState().editorDrafts[file.id] ?? null
  }

  const syncAutoSave = (): void => {
    const state = store.getState()
    const openFilesById = new Map(state.openFiles.map((file) => [file.id, file]))

    for (const fileId of Array.from(autoSaveTimers.keys())) {
      const file = openFilesById.get(fileId)
      const draft = state.editorDrafts[fileId]
      const shouldKeepTimer =
        state.settings?.editorAutoSave &&
        file &&
        file.isDirty &&
        canAutoSaveOpenFile(file) &&
        draft !== undefined
      if (!shouldKeepTimer) {
        clearAutoSaveTimer(fileId)
      }
    }

    if (!state.settings?.editorAutoSave) {
      return
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings.editorAutoSaveDelayMs)
    for (const file of state.openFiles) {
      const draft = state.editorDrafts[file.id]
      if (!file.isDirty || draft === undefined || !canAutoSaveOpenFile(file)) {
        clearAutoSaveTimer(file.id)
        continue
      }

      if (autoSaveTimers.has(file.id) && autoSaveScheduledContent.get(file.id) === draft) {
        continue
      }

      clearAutoSaveTimer(file.id)
      autoSaveScheduledContent.set(file.id, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(file.id)
        autoSaveScheduledContent.delete(file.id)
        void queueSave(file, draft)
      }, autoSaveDelayMs)
      autoSaveTimers.set(file.id, timerId)
    }
  }

  const handleSaveDirtyFiles = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<EditorSaveDirtyFilesDetail>).detail
    if (!detail) {
      return
    }

    try {
      detail.claim()

      const dirtyFiles = store.getState().openFiles.filter((file) => file.isDirty)
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
        // Why: a hidden autosave controller still has to respect that edit tabs
        // and unstaged diff tabs may point at the same path while holding
        // different drafts. Refusing the restart is safer than choosing a
        // winner implicitly and persisting whichever save races last.
        detail.reject(
          'Some unsaved files are open in multiple dirty tabs. Save them manually before restarting.'
        )
        return
      }

      await Promise.all(
        dirtyFiles.map(async (file) => {
          const content = getLatestWritableContent(file)
          if (content === null) {
            throw new Error(`Missing editor buffer for ${file.relativePath}`)
          }
          await queueSave(file, content)
        })
      )
      detail.resolve()
    } catch (error) {
      detail.reject(String((error as Error)?.message ?? error))
    }
  }

  const handleSaveAndClose = async (event: Event): Promise<void> => {
    const { fileId } = (event as CustomEvent<{ fileId: string }>).detail
    const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)
    if (!file) {
      return
    }

    flushPendingEditorChange(file.id)
    const draft = store.getState().editorDrafts[fileId]
    if (draft !== undefined) {
      try {
        await queueSave(file, draft)
      } catch {
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

      flushPendingEditorChange(file.id)

      const content = store.getState().editorDrafts[file.id] ?? detail.fallbackContent
      if (content === undefined) {
        detail.resolve()
        return
      }

      await queueSave(file, content)
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

  const handleExternalFileChange = (event: Event): void => {
    const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
    if (!detail) {
      return
    }

    const state = store.getState()
    const matchingFiles = getOpenFilesForExternalFileChange(state.openFiles, detail)
    if (matchingFiles.length === 0) {
      return
    }

    for (const file of matchingFiles) {
      clearAutoSaveTimer(file.id)
      bumpSaveGeneration(file.id)
      state.markFileDirty(file.id, false)
    }
    state.clearEditorDrafts(matchingFiles.map((file) => file.id))
  }

  const unsubscribe = store.subscribe(syncAutoSave)
  syncAutoSave()

  window.addEventListener(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, handleSaveDirtyFiles as EventListener)
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
      ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
      handleSaveAndClose as EventListener
    )
    window.removeEventListener(ORCA_EDITOR_SAVE_FILE_EVENT, handleSaveFile as EventListener)
    window.removeEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handleQuiesce as EventListener)
    window.removeEventListener(
      ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
      handleExternalFileChange as EventListener
    )
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    saveQueue.clear()
    saveGeneration.clear()
  }
}

export function attachAppEditorAutosaveController(): () => void {
  return attachEditorAutosaveController(useAppStore)
}
