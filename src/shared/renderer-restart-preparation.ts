import { requestEditorHotExitBackup } from './editor-hot-exit-request'
import {
  consumeShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT
} from './renderer-shutdown-events'
import type { UpdateStatus } from './update-status-types'

export type AppRestartPrepOptions = {
  startedEventName: string
  abortedEventName: string
  /** False for automatic restarts; only a user who asked to restart may be asked about unsaved work. */
  userInitiated: boolean
  /** Joins the durable write of the state the checkpoint staged; rejects if it failed. */
  awaitCheckpoint: () => Promise<void>
}

export async function prepareRendererForAppRestart(
  eventTarget: EventTarget,
  { startedEventName, abortedEventName, userInitiated, awaitCheckpoint }: AppRestartPrepOptions
): Promise<void> {
  let checkpointFailed = false

  try {
    await requestEditorHotExitBackup(eventTarget, userInitiated)
    eventTarget.dispatchEvent(new Event(startedEventName))
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
      // Why: the guard publishes the swallowed persist error out-of-band; naming it
      // here is the only way the update-error dialog can say what actually failed.
      const reason = consumeShutdownCheckpointFailureReason()
      throw new Error(
        reason
          ? `Renderer shutdown checkpoint was not completed: ${reason}`
          : 'Renderer shutdown checkpoint was not completed.'
      )
    }
    // Why: the checkpoint only stages synchronously. Navigating before that
    // write lands loses the session snapshot to a crash or power loss.
    await awaitCheckpoint()
  } catch (error) {
    // A checkpoint failure ends the current restart without abandoning the
    // retry-then-degrade budget that the next user attempt must consume.
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
      // Why: quitAndInstall IPC resolves after scheduling; a later updater
      // error is the authoritative signal that the app will remain open.
      if (status.state === 'error') {
        abort()
      }
    }
  }
}
