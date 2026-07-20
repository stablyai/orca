/* eslint-disable max-lines -- Why: keeping the save queue, quiesce coordination, and dirty-file shutdown hooks together avoids split-brain saves. */
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { shouldPersistWorkspaceSession } from '@/lib/workspace-session'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { writeRuntimeFile } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  isAutosaveSuspendedForFile,
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
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { flushPendingEditorChange } from './editor-pending-flush'
import {
  clearSelfWrite,
  hasRecentSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from './diff-content-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import {
  autosaveSubscriberInputsEqual,
  getAutosaveSubscriberInputs,
  getDuplicateDirtySavePaths
} from './editor-autosave-state-projections'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
  type EditorPrepareHotExitDetail,
  type EditorSaveDirtyFilesDetail
} from '../../../../shared/editor-save-events'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

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

  const queueSave = (
    file: OpenFile,
    fallbackContent: string,
    trigger: 'autosave' | 'user' = 'user'
  ): Promise<void> => {
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

        // Why: read-only tabs (AI Vault View Log) must never write the agent-owned artifact through editor paths.
        if (liveFile.readOnly === true) {
          return
        }

        // Why: only autosave is blocked while suspended; explicit user saves proceed (the banner warned).
        if (trigger === 'autosave' && isAutosaveSuspendedForFile(liveFile)) {
          return
        }

        const contentToSave = state.editorDrafts[file.id] ?? fallbackContent
        const connectionId =
          getConnectionIdForFile(liveFile.worktreeId, liveFile.filePath) ?? undefined
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
        recordSelfWrite(
          liveFile.filePath,
          contentToSave,
          liveFile.runtimeEnvironmentId,
          connectionId || liveFile.runtimeEnvironmentId?.trim()
            ? SELF_WRITE_REMOTE_TTL_MS
            : undefined
        )
        try {
          await writeRuntimeFile(
            {
              settings: settingsForRuntimeOwner(state.settings, liveFile.runtimeEnvironmentId),
              worktreeId: liveFile.worktreeId,
              worktreePath: worktree?.path ?? null,
              connectionId
            },
            liveFile.filePath,
            contentToSave
          )
        } catch (error) {
          // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          throw error
        }

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
        // Why: disk now holds contentToSave — rebaseline so our own save isn't flagged external; drop pending verification.
        nextState.setLastKnownDiskSignature(file.id, getDiskBaselineSignature(contentToSave))
        nextState.clearPendingDiskBaselineVerification(file.id)
        // Why: the write made disk match the buffer, so clear any now-stale changed-on-disk conflict.
        const savedFile = nextState.openFiles.find((openFile) => openFile.id === file.id)
        if (savedFile?.externalMutation === 'changed') {
          trackExternalChangeConflictAction(savedFile, 'save_overwrite')
          nextState.setExternalMutation(file.id, null)
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
    // Why: rich markdown debounces serialization, so force the pending draft out before we cancel timers.
    flushPendingEditorChange(fileId)
    const pendingSave = saveQueue.get(fileId)
    clearAutoSaveTimer(fileId)
    bumpSaveGeneration(fileId)
    await pendingSave?.catch(() => undefined)
  }

  const getLatestWritableContent = (file: OpenFile): string | null => {
    // Why: headless controller reads editorDrafts rather than mounting the editor UI to read component-local buffers.
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
        // Why: suspension holds until the user picks a side via the banner (or saves manually).
        !isAutosaveSuspendedForFile(file) &&
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
      if (
        !file.isDirty ||
        draft === undefined ||
        !canAutoSaveOpenFile(file) ||
        isAutosaveSuspendedForFile(file)
      ) {
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
        void queueSave(file, draft, 'autosave')
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
        // Why: edit and diff tabs can share a path with different drafts; refuse rather than race an implicit winner.
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

    // Why: keep dirty drafts on external writes (data-loss half of #7265); mark changed-on-disk as backstop for tabs turned dirty during the notify debounce.
    const reloadingFiles = matchingFiles.filter((file) => !file.isDirty)
    for (const file of matchingFiles) {
      if (file.isDirty) {
        // Why: skip Orca's own-save echo, which routes here bypassing the watch hook's echo verification.
        if (!hasRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)) {
          markFileChangedOnDisk(state, file, {
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
            origin: 'live'
          })
        }
        continue
      }
      clearAutoSaveTimer(file.id)
      bumpSaveGeneration(file.id)
      state.markFileDirty(file.id, false)
      // Why: about to reload fresh disk content, so a stale changed-on-disk mark is resolved.
      if (file.externalMutation === 'changed') {
        state.setExternalMutation(file.id, null)
      }
    }
    state.clearEditorDrafts(reloadingFiles.map((file) => file.id))
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
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    saveQueue.clear()
    saveGeneration.clear()
  }
}
