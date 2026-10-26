export type WindowVisibilityIntervalTimer = ReturnType<typeof setInterval>
export type WindowVisibilityJitterTimer = ReturnType<typeof setTimeout>

const MAX_VISIBILITY_JITTER_MS = 400

export function isWindowVisible(): boolean {
  return (
    typeof document === 'undefined' ||
    document.visibilityState === undefined ||
    document.visibilityState === 'visible'
  )
}

export function installWindowVisibilityInterval(args: {
  run: () => void
  // Visibility transition is evidence-bearing for hidden signal-dropping callers; default it to run.
  runOnVisible?: () => void
  intervalMs: number
  setIntervalFn?: (callback: () => void, intervalMs: number) => WindowVisibilityIntervalTimer
  clearIntervalFn?: (handle: WindowVisibilityIntervalTimer) => void
  jitterOnVisible?: boolean
  jitterFn?: () => number
}): () => void {
  const setIntervalFn =
    args.setIntervalFn ??
    ((callback: () => void, intervalMs: number): WindowVisibilityIntervalTimer =>
      setInterval(callback, intervalMs))
  const clearIntervalFn =
    args.clearIntervalFn ?? ((handle: WindowVisibilityIntervalTimer): void => clearInterval(handle))
  let intervalId: WindowVisibilityIntervalTimer | null = null
  let visibilityJitterId: WindowVisibilityJitterTimer | null = null
  const visibilityJitterMs = args.jitterOnVisible
    ? Math.max(
        0,
        Math.min(
          MAX_VISIBILITY_JITTER_MS,
          Math.floor(args.jitterFn?.() ?? Math.random() * (MAX_VISIBILITY_JITTER_MS + 1))
        )
      )
    : 0

  const stop = (): void => {
    if (visibilityJitterId !== null) {
      clearTimeout(visibilityJitterId)
      visibilityJitterId = null
    }
    if (intervalId !== null) {
      clearIntervalFn(intervalId)
      intervalId = null
    }
  }
  const start = (jitterVisibleRun: boolean): void => {
    if (intervalId !== null || !isWindowVisible()) {
      return
    }
    const visibleRun = args.runOnVisible ?? args.run
    if (jitterVisibleRun) {
      visibilityJitterId = setTimeout(() => {
        visibilityJitterId = null
        if (isWindowVisible()) {
          visibleRun()
        }
      }, visibilityJitterMs)
    } else {
      visibleRun()
    }
    /** Pause expensive IPC/process intervals only while unpresentable; visible unfocused windows still need fresh status on other displays. */
    intervalId = setIntervalFn(args.run, args.intervalMs)
  }
  const reconcile = (): void => {
    if (isWindowVisible()) {
      start(args.jitterOnVisible === true)
    } else {
      stop()
    }
  }

  start(false)
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcile)
  }
  return () => {
    stop()
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcile)
    }
  }
}
