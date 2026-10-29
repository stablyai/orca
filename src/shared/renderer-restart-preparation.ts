import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from './editor-save-events'
import {
  consumeShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT
} from './renderer-shutdown-events'
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

    // Before autosave mounts, no claimant means no renderer-owned dirty buffers to back up.
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
  let checkpointFailed = false

  try {
    await requestEditorHotExitBackup(eventTarget)
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
      // The guard swallows persist errors; its out-of-band reason gives the update dialog the actual cause.
      const reason = consumeShutdownCheckpointFailureReason()
      throw new Error(
        reason
          ? `Renderer shutdown checkpoint was not completed: ${reason}`
          : 'Renderer shutdown checkpoint was not completed.'
      )
    }
    // Await durability: synchronous checkpoint staging alone cannot survive a crash or power loss.
    await awaitCheckpoint()
  } catch (error) {
    // Preserve the retry-then-degrade budget for the next user restart attempt.
    eventTarget.dispatchEvent(
      new Event(
        checkpointFailed ? ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT : abortedEventName
      )
    )
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
      // quitAndInstall only schedules work; a later updater error means the app remains open.
      if (status.state === 'error') {
        abort()
      }
    }
  }
}
