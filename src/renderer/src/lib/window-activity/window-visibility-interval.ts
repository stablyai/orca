import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'

export type WindowVisibilityIntervalTimer = ReturnType<typeof setInterval>
export type WindowVisibilityJitterTimer = ReturnType<typeof setTimeout>

const MAX_VISIBILITY_JITTER_MS = 400
// Visible windows behind another app slow remote/process polls instead of pausing (other displays still show them).
const UNFOCUSED_POLL_SLOWDOWN = 4

export function isWindowVisible(): boolean {
  return (
    typeof document === 'undefined' ||
    document.visibilityState === undefined ||
    document.visibilityState === 'visible'
  )
}

export function windowPollSlowdown(): number {
  return isOrcaWindowForegroundFocused() ? 1 : UNFOCUSED_POLL_SLOWDOWN
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
  // Stretch the cadence by UNFOCUSED_POLL_SLOWDOWN while unfocused; overdue runs catch up on focus.
  slowWhileUnfocused?: boolean
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
  let lastRunAt = -Infinity
  const runNow = (run: () => void): void => {
    lastRunAt = Date.now()
    run()
  }
  const tick = (): void => {
    // Read focus at fire time: window blur also fires when focus merely moves into a webview/iframe.
    if (args.slowWhileUnfocused) {
      const slowdown = windowPollSlowdown()
      if (
        slowdown > 1 &&
        Date.now() - lastRunAt + args.intervalMs / 2 < args.intervalMs * slowdown
      ) {
        return
      }
    }
    runNow(args.run)
  }
  const start = (jitterVisibleRun: boolean, visibleRun: () => void): void => {
    if (intervalId !== null || !isWindowVisible()) {
      return
    }
    if (jitterVisibleRun) {
      visibilityJitterId = setTimeout(() => {
        visibilityJitterId = null
        if (isWindowVisible()) {
          runNow(visibleRun)
        }
      }, visibilityJitterMs)
    } else {
      runNow(visibleRun)
    }
    /** Pause expensive IPC/process intervals only while unpresentable; visible unfocused windows still need fresh status on other displays. */
    intervalId = setIntervalFn(tick, args.intervalMs)
  }
  const catchUpOnFocus = (): void => {
    if (
      intervalId === null ||
      visibilityJitterId !== null ||
      Date.now() - lastRunAt < args.intervalMs
    ) {
      return
    }
    // Restart the phase so the catch-up run is not followed by an immediate interval tick.
    stop()
    start(false, args.run)
  }
  const reconcile = (): void => {
    if (isWindowVisible()) {
      start(args.jitterOnVisible === true, args.runOnVisible ?? args.run)
    } else {
      stop()
    }
  }

  start(false, args.runOnVisible ?? args.run)
  const listensForFocus =
    args.slowWhileUnfocused === true &&
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  if (listensForFocus) {
    window.addEventListener('focus', catchUpOnFocus)
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcile)
  }
  return () => {
    stop()
    if (listensForFocus) {
      window.removeEventListener('focus', catchUpOnFocus)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcile)
    }
  }
}
