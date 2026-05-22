export type WindowVisibilityIntervalTimer = ReturnType<typeof setInterval>

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
  setIntervalFn?: (callback: () => void, intervalMs: number) => WindowVisibilityIntervalTimer
  clearIntervalFn?: (handle: WindowVisibilityIntervalTimer) => void
}): () => void {
  const setIntervalFn =
    args.setIntervalFn ??
    ((callback: () => void, intervalMs: number): WindowVisibilityIntervalTimer =>
      setInterval(callback, intervalMs))
  const clearIntervalFn =
    args.clearIntervalFn ?? ((handle: WindowVisibilityIntervalTimer): void => clearInterval(handle))
  let intervalId: WindowVisibilityIntervalTimer | null = null

  const stop = (): void => {
    if (!intervalId) {
      return
    }
    clearIntervalFn(intervalId)
    intervalId = null
  }
  const start = (): void => {
    if (intervalId || !isWindowVisible()) {
      return
    }
    args.run()
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
