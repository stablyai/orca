import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from './editor-save-events'
import { ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT } from './renderer-shutdown-events'
import type { UpdateStatus } from './update-status-types'

export type AppRestartPrepOptions = {
  startedEventName: string
  abortedEventName: string
  /** Joins the durable write of the state the checkpoint staged; rejects if it failed. */
  awaitCheckpoint: () => Promise<void>
}

function requestEditorHotExitBackup(eventTarget: EventTarget): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let claimed = false
    eventTarget.dispatchEvent(
      new CustomEvent<EditorPrepareHotExitDetail>(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, {
        detail: {
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message) => {
            reject(new Error(message))
          }
        }
      })
    )

    // Why: restart paths can run before the editor autosave controller mounts.
    // With no claimant, there are no renderer-owned dirty buffers to back up.
    if (!claimed) {
      resolve()
    }
  })
}

export async function prepareRendererForAppRestart(
  eventTarget: EventTarget,
  { startedEventName, abortedEventName, awaitCheckpoint }: AppRestartPrepOptions
): Promise<void> {
  eventTarget.dispatchEvent(new Event(startedEventName))

  try {
    await requestEditorHotExitBackup(eventTarget)
    let checkpointFailed = false
    const markCheckpointFailed = (): void => {
      checkpointFailed = true
    }
    eventTarget.addEventListener(
      ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
      markCheckpointFailed
    )
    try {
      // Why: the aggregate unload verdict also includes unrelated listeners.
      eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    } finally {
      eventTarget.removeEventListener(
        ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
        markCheckpointFailed
      )
    }
    if (checkpointFailed) {
      throw new Error('Renderer shutdown checkpoint was not completed.')
    }
    // Why: the checkpoint only stages synchronously. Navigating before that
    // write lands loses the session snapshot to a crash or power loss.
    await awaitCheckpoint()
  } catch (error) {
    eventTarget.dispatchEvent(new Event(abortedEventName))
    throw error
  }
}

export type UpdaterQuitAbortRelay = {
  markPrepared: () => void
  abort: () => void
  handleStatus: (status: UpdateStatus) => void
}

export function createUpdaterQuitAbortRelay(
  eventTarget: EventTarget,
  abortedEventName: string
): UpdaterQuitAbortRelay {
  let prepared = false
  const abort = (): void => {
    if (!prepared) {
      return
    }
    prepared = false
    eventTarget.dispatchEvent(new Event(abortedEventName))
  }

  return {
    markPrepared(): void {
      prepared = true
    },
    abort,
    handleStatus(status): void {
      // Why: quitAndInstall IPC resolves after scheduling; a later updater
      // error is the authoritative signal that the app will remain open.
      if (status.state === 'error') {
        abort()
      }
    }
  }
}
