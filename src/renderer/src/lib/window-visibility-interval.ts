export type WindowVisibilityIntervalTimer = ReturnType<typeof setInterval>
export type WindowVisibilityTimeoutTimer = ReturnType<typeof setTimeout>

export function isWindowVisible(): boolean {
  return (
    typeof document === 'undefined' ||
    typeof document.visibilityState === 'undefined' ||
    document.visibilityState === 'visible'
  )
}

export function installWindowVisibilityInterval(args: {
  run: () => void
  intervalMs: number
  /**
   * Defaults to true for existing callers. Set false for expensive background
   * refreshes that should wait for the first interval tick.
   */
  runImmediately?: boolean
  /**
   * Optional delay for the first run while the window is visible. This keeps
   * startup/hydration paths from competing with expensive polling work.
   */
  initialDelayMs?: number
  setIntervalFn?: (callback: () => void, intervalMs: number) => WindowVisibilityIntervalTimer
  clearIntervalFn?: (handle: WindowVisibilityIntervalTimer) => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => WindowVisibilityTimeoutTimer
  clearTimeoutFn?: (handle: WindowVisibilityTimeoutTimer) => void
}): () => void {
  const setIntervalFn =
    args.setIntervalFn ??
    ((callback: () => void, intervalMs: number): WindowVisibilityIntervalTimer =>
      setInterval(callback, intervalMs))
  const clearIntervalFn =
    args.clearIntervalFn ?? ((handle: WindowVisibilityIntervalTimer): void => clearInterval(handle))
  const setTimeoutFn =
    args.setTimeoutFn ??
    ((callback: () => void, delayMs: number): WindowVisibilityTimeoutTimer =>
      setTimeout(callback, delayMs))
  const clearTimeoutFn =
    args.clearTimeoutFn ?? ((handle: WindowVisibilityTimeoutTimer): void => clearTimeout(handle))
  let intervalId: WindowVisibilityIntervalTimer | null = null
  let initialTimeoutId: WindowVisibilityTimeoutTimer | null = null

  const stopInitialTimeout = (): void => {
    if (!initialTimeoutId) {
      return
    }
    clearTimeoutFn(initialTimeoutId)
    initialTimeoutId = null
  }

  const stop = (): void => {
    stopInitialTimeout()
    if (!intervalId) {
      return
    }
    clearIntervalFn(intervalId)
    intervalId = null
  }

  const runInitial = (): void => {
    const delayMs = Math.max(0, args.initialDelayMs ?? 0)
    if (args.runImmediately === false && delayMs === 0) {
      return
    }
    if (delayMs > 0) {
      initialTimeoutId = setTimeoutFn(() => {
        initialTimeoutId = null
        if (isWindowVisible()) {
          args.run()
        }
      }, delayMs)
      return
    }
    args.run()
  }

  const start = (): void => {
    if (intervalId || initialTimeoutId || !isWindowVisible()) {
      return
    }
    runInitial()
    // Why: many callers shell out or cross IPC. Keep their interval alive only
    // while Orca can present the refreshed data, but still refresh a visible
    // unfocused window so status UI does not go stale on a second display.
    intervalId = setIntervalFn(args.run, args.intervalMs)
  }
  const reconcile = (): void => {
    if (isWindowVisible()) {
      start()
    } else {
      stop()
    }
  }

  start()
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
