import { isWindowVisible } from './window-visibility-interval'

export type WindowVisibilityTimeoutPollerTimer = ReturnType<typeof setTimeout>

export function installWindowVisibilityTimeoutPoller(args: {
  run: () => Promise<void> | void
  getDelayMs: () => number
  setTimeoutFn?: (callback: () => void, delayMs: number) => WindowVisibilityTimeoutPollerTimer
  clearTimeoutFn?: (handle: WindowVisibilityTimeoutPollerTimer) => void
}): () => void {
  const setTimeoutFn =
    args.setTimeoutFn ??
    ((callback: () => void, delayMs: number): WindowVisibilityTimeoutPollerTimer =>
      setTimeout(callback, delayMs))
  const clearTimeoutFn =
    args.clearTimeoutFn ??
    ((handle: WindowVisibilityTimeoutPollerTimer): void => clearTimeout(handle))
  let timeoutId: WindowVisibilityTimeoutPollerTimer | null = null
  let disposed = false
  let inFlight = false

  const clearScheduledPoll = (): void => {
    if (!timeoutId) {
      return
    }
    clearTimeoutFn(timeoutId)
    timeoutId = null
  }

  const schedulePoll = (): void => {
    clearScheduledPoll()
    if (disposed || !isWindowVisible()) {
      return
    }
    timeoutId = setTimeoutFn(() => {
      timeoutId = null
      runAndSchedule()
    }, args.getDelayMs())
  }

  function runAndSchedule(): void {
    clearScheduledPoll()
    if (disposed || !isWindowVisible() || inFlight) {
      return
    }
    inFlight = true
    void Promise.resolve(args.run()).finally(() => {
      inFlight = false
      schedulePoll()
    })
  }

  const reconcileVisibility = (): void => {
    if (isWindowVisible()) {
      runAndSchedule()
    } else {
      clearScheduledPoll()
    }
  }

  runAndSchedule()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', reconcileVisibility)
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcileVisibility)
  }

  return () => {
    disposed = true
    clearScheduledPoll()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', reconcileVisibility)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcileVisibility)
    }
  }
}
