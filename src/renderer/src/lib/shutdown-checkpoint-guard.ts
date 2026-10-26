import {
  clearShutdownCheckpointFailureReason,
  formatShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT,
  publishShutdownCheckpointFailureReason
} from '../../../shared/renderer-shutdown-events'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export type ShutdownCheckpointGuard = {
  persistOnce: () => boolean
  abortAfterCheckpointFailure: () => void
  abandonAttempt: () => void
}

// Report checkpoint causes or reproducible failures strand users on old builds behind symptom-only errors (STA-5505).
function reportShutdownCheckpointFailure(error: unknown): void {
  console.error('[app] Shutdown checkpoint persist failed:', error)
  const message = formatShutdownCheckpointFailureReason(error)
  publishShutdownCheckpointFailureReason(message)
  recordRendererCrashBreadcrumb('renderer_shutdown_checkpoint_failed', { message })
}

export function createShutdownCheckpointGuard(
  persist: () => void,
  abandonPersistAttempt?: () => void
): ShutdownCheckpointGuard {
  let persisted = false
  return {
    persistOnce(): boolean {
      if (persisted) {
        return true
      }
      try {
        persist()
      } catch (error) {
        // Browser event targets swallow exceptions; return failure so callers can cancel unload and retry.
        reportShutdownCheckpointFailure(error)
        return false
      }
      persisted = true
      clearShutdownCheckpointFailureReason()
      return true
    },
    abortAfterCheckpointFailure(): void {
      persisted = false
    },
    abandonAttempt(): void {
      persisted = false
      abandonPersistAttempt?.()
    }
  }
}

export function createShutdownCheckpointBeforeUnloadHandler(
  guard: ShutdownCheckpointGuard
): (event: Event) => void {
  return (event): void => {
    if (!guard.persistOnce()) {
      event.currentTarget?.dispatchEvent(new Event(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT))
      event.preventDefault()
    }
  }
}

export function preventUnloadAndScheduleShutdownCheckpointReset(
  event: Event,
  eventTarget: EventTarget
): void {
  event.preventDefault()
  // Paired web lacks will-prevent-unload; reset successful checkpoints after all beforeunload listeners finish.
  queueMicrotask(() => {
    eventTarget.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
  })
}
