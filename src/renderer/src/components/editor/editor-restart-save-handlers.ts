import type { OpenFile } from '@/store/slices/editor'
import { shouldPersistWorkspaceSession } from '@/lib/workspace-session'
import { getBackedUpEditorDraft } from '@/lib/editor-draft-backup'
import { canAutoSaveOpenFile } from './editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'
import { getDuplicateDirtySavePaths, restartSaveTargets } from './editor-autosave-state-projections'
import type { AppStoreApi, EditorSaveQueue } from './editor-save-queue'
import { requestRestartUnsavedChangesDecision } from './restart-unsaved-changes-dialog'
import type { EditorSaveDirtyFilesDetail } from '../../../../shared/editor-save-events'
import { acceptEditorHotExitRequest } from '../../../../shared/editor-hot-exit-request'
import { APP_RESTART_CANCELLED_BY_USER_MESSAGE } from '../../../../shared/app-restart-cancellation'

const RESTART_SAVE_TIME_LIMIT_MS = 5_000

function settleWithin(work: Promise<unknown>, deadline: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, Math.max(0, deadline - performance.now()))
    void work.then(
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

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

  // Why: with autosave on, saving is what the user asked for; only what's left needs the backup or the dialog.
  const autoSaveBeforeRestart = async (deadline: number): Promise<void> => {
    const state = store.getState()
    if (!state.settings?.editorAutoSave) {
      return
    }
    const dirtyFiles = restartSaveTargets(state)
    const duplicateDirtySavePaths = new Set(getDuplicateDirtySavePaths(dirtyFiles))
    const saves: Promise<unknown>[] = []
    for (const file of dirtyFiles) {
      const draft = state.editorDrafts[file.id]
      if (
        draft === undefined ||
        !canAutoSaveOpenFile(file) ||
        duplicateDirtySavePaths.has(file.filePath)
      ) {
        continue
      }
      saves.push(
        queueSave(file, draft, 'autosave', deadline).catch((error) => {
          console.error('[editor] save before restart failed', error)
        })
      )
    }
    await Promise.all(saves)
  }

  const handlePrepareHotExit = async (event: Event): Promise<void> => {
    const request = acceptEditorHotExitRequest(event)
    if (!request) {
      return
    }

    try {
      const deadline = performance.now() + RESTART_SAVE_TIME_LIMIT_MS
      const initiallyDirtyFiles = store.getState().openFiles.filter((file) => file.isDirty)
      const drains = initiallyDirtyFiles.map((file) => settleFileSaves(file.id))
      // Settlement flushes synchronously; healthy records need not wait for stalled saves.
      await settleWithin(Promise.all([...drains, autoSaveBeforeRestart(deadline)]), deadline)

      const confirmedLostFileIds = new Set<string>()
      for (;;) {
        const state = store.getState()
        const dirtyFiles = state.openFiles.filter((file) => file.isDirty)
        if (dirtyFiles.length > 0 && !shouldPersistWorkspaceSession(state)) {
          request.reject(
            'Unsaved editor changes cannot be backed up until workspace restore finishes.'
          )
          return
        }
        const notBackedUp = dirtyFiles.filter(
          (file) => getBackedUpEditorDraft(file, state.editorDrafts) === undefined
        )
        // Why: the dialog is awaited, so files can join meanwhile; consent covers only the files it named.
        if (notBackedUp.every((file) => confirmedLostFileIds.has(file.id))) {
          break
        }
        const decision = request.userInitiated
          ? requestRestartUnsavedChangesDecision([
              ...new Set(notBackedUp.map((file) => file.relativePath))
            ])
          : null
        if (!decision) {
          request.reject('Some unsaved editor changes cannot be backed up before restart.')
          return
        }
        if ((await decision) !== 'restart-anyway') {
          request.reject(APP_RESTART_CANCELLED_BY_USER_MESSAGE)
          return
        }
        for (const file of notBackedUp) {
          confirmedLostFileIds.add(file.id)
        }
      }

      // Why: preload dispatches beforeunload immediately after this resolves;
      // App owns the one combined session/UI checkpoint for restart and update.
      request.resolve()
    } catch (error) {
      request.reject(error instanceof Error ? error.message : String(error))
    }
  }

  return { handleSaveDirtyFiles, handlePrepareHotExit }
}
