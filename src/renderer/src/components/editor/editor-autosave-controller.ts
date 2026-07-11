/* eslint-disable max-lines -- Why: autosave owns the save queue, quiesce
coordination, and dirty-file shutdown hooks; keeping those lifecycles together
avoids split-brain saves across visible and hidden editors. */
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from '@/lib/workspace-session'
import { persistWorkspaceSessionByHostSync } from '@/lib/workspace-session-host-persistence'
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

        // Why: hard no-op for read-only tabs (AI Vault View Log) even if a stray
        // user/autosave save reached the queue — the integrity invariant is that
        // View Log never writes the agent-owned artifact through editor paths.
        if (liveFile.readOnly === true) {
          return
        }

        // Why: explicit user saves proceed even while suspended (the banner
        // warned) and clear both suspension flags below.
        if (trigger === 'autosave' && isAutosaveSuspendedForFile(liveFile)) {
          return
        }

        const contentToSave = state.editorDrafts[file.id] ?? fallbackContent
        const connectionId =
          getConnectionIdForFile(liveFile.worktreeId, liveFile.filePath) ?? undefined
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        // Why: stamp before the write so the fs:changed event that our own
        // write produces is ignored by useEditorExternalWatch instead of
        // round-tripping back into a setContent that jumps the cursor to the
        // end (and, under round-trip drift, can drop keystrokes typed in the
        // debounce window). See editor-self-write-registry.
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
          // Why: the self-write stamp is only valid if a disk write actually
          // happened. Clearing it on failure keeps the external watcher from
          // suppressing a real third-party update that lands during the TTL.
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
        // Why: disk now holds contentToSave — future edits baseline on it, and
        // a restore must not flag our own save as an external change. An
        // explicit save also settles any pending baseline verification: the
        // user chose to write, so there is nothing left to verify against.
        nextState.setLastKnownDiskSignature(file.id, getDiskBaselineSignature(contentToSave))
        nextState.clearPendingDiskBaselineVerification(file.id)
        // Why: the write just made disk match the buffer, resolving any
        // changed-on-disk conflict in favor of the user's content. The banner
        // warned before this point; keeping the mark would show a stale
        // conflict for a file that no longer diverges.
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
        // Why: suspension holds until the user picks a side via the banner
        // (or saves manually) — see the queueSave guard.
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

      // Why: restart/update may quit before the debounced session writer fires.
      // Write the full session now so dirty drafts restore as unsaved tabs.
      if (shouldPersistWorkspaceSession(state)) {
        // Why: runtime-owned worktree slices persist under their host
        // partition, mirroring the debounced writer's split.
        persistWorkspaceSessionByHostSync(
          window.api.session,
          buildWorkspaceSessionPayload(state),
          state
        )
      }
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

    // Why: dirty files must keep their draft — destroying unsaved edits on an
    // external write is the data-loss half of issue #7265. Mark them
    // changed-on-disk instead (backstop for tabs that became dirty during the
    // notify debounce; the watch hook marks the ones dirty at event time).
    const reloadingFiles = matchingFiles.filter((file) => !file.isDirty)
    for (const file of matchingFiles) {
      if (file.isDirty) {
        // Why: the self-write check keeps this backstop from marking on the
        // echo of Orca's own save (the combined-Changes reload notification
        // routes through here and would otherwise bypass the watch hook's
        // echo verification).
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
      // Why: this file is about to reload fresh disk content, so a stale
      // changed-on-disk mark (set while it was dirty) is resolved.
      if (file.externalMutation === 'changed') {
        state.setExternalMutation(file.id, null)
      }
    }
    state.clearEditorDrafts(reloadingFiles.map((file) => file.id))
  }

  // Why: the root store subscriber fires for every terminal title/focus tick.
  // Autosave only reads these four inputs, so skip the open-files scan when
  // unrelated store slices change.
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
