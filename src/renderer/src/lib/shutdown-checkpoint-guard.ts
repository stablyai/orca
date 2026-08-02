import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'

export type ShutdownCheckpointGuard = {
  persistOnce: () => boolean
  reset: () => void
}

export function createShutdownCheckpointGuard(persist: () => void): ShutdownCheckpointGuard {
  let persisted = false
  return {
    persistOnce(): boolean {
      if (persisted) {
        return true
      }
      try {
        persist()
      } catch {
        // Why: browser event targets swallow listener exceptions. Returning a
        // failure lets the caller cancel unload and keep this attempt retryable.
        return false
      }
      persisted = true
      return true
    },
    reset(): void {
      persisted = false
    }
  }
}

export function createShutdownCheckpointBeforeUnloadHandler(
  guard: ShutdownCheckpointGuard
): (event: Event) => void {
  return (event): void => {
    if (!guard.persistOnce()) {
      event.preventDefault()
    }
  }
}

export function preventUnloadAndScheduleShutdownCheckpointReset(
  event: Event,
  eventTarget: EventTarget
): void {
  event.preventDefault()
  // Why: paired web has no Electron will-prevent-unload callback. Defer until
  // all beforeunload listeners finish so their successful checkpoint is reset.
  queueMicrotask(() => {
    eventTarget.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
  })
}
