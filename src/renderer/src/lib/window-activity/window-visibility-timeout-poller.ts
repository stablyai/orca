import { isWindowVisible } from './window-visibility-interval'

export type WindowVisibilityTimeoutPollerTimer = ReturnType<typeof setTimeout>

/** Why a run started: its own timer, the window coming back, an explicit refresh, or install. */
export type WindowVisibilityPollerTrigger = 'timer' | 'visibility' | 'refresh' | 'install'

export function installWindowVisibilityTimeoutPoller(args: {
  run: (context: { trigger: WindowVisibilityPollerTrigger }) => Promise<void> | void
  getDelayMs: () => number | null
  cooldownMs?: number
  setTimeoutFn?: (callback: () => void, delayMs: number) => WindowVisibilityTimeoutPollerTimer
  clearTimeoutFn?: (handle: WindowVisibilityTimeoutPollerTimer) => void
}): (() => void) & { refresh: () => void; replan: () => void } {
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
  let lastRunAt = -Infinity

  const clearScheduledPoll = (): void => {
    if (timeoutId === null) {
      return
    }
    clearTimeoutFn(timeoutId)
    timeoutId = null
  }

  const schedulePoll = (remainingMs?: number): void => {
    clearScheduledPoll()
    if (disposed || !isWindowVisible()) {
      return
    }
    const delayMs = args.getDelayMs()
    if (delayMs === null) {
      return
    }
    timeoutId = setTimeoutFn(() => {
      timeoutId = null
      runAndSchedule('timer')
    }, remainingMs ?? delayMs)
  }

  function runAndSchedule(trigger: WindowVisibilityPollerTrigger): void {
    if (disposed || !isWindowVisible() || inFlight) {
      return
    }
    const explicitRefresh = trigger === 'refresh'
    const elapsedMs = Date.now() - lastRunAt
    const cooldownRemainingMs = (args.cooldownMs ?? 0) - elapsedMs
    if (cooldownRemainingMs > 0) {
      if (explicitRefresh) {
        clearScheduledPoll()
        timeoutId = setTimeoutFn(() => {
          timeoutId = null
          runAndSchedule('refresh')
        }, cooldownRemainingMs)
      }
      return
    }
    clearScheduledPoll()
    lastRunAt = Date.now()
    inFlight = true
    const finish = (): void => {
      inFlight = false
      schedulePoll()
    }
    try {
      void Promise.resolve(args.run({ trigger })).then(finish, finish)
    } catch {
      finish()
    }
  }

  const reconcileVisibility = (): void => {
    if (isWindowVisible()) {
      const delayMs = args.getDelayMs()
      const elapsedMs = Date.now() - lastRunAt
      if (args.cooldownMs && delayMs !== null && elapsedMs < delayMs) {
        if (timeoutId === null && !inFlight) {
          schedulePoll(delayMs - elapsedMs)
        }
        return
      }
      runAndSchedule('visibility')
    } else {
      clearScheduledPoll()
    }
  }
  const reconcileFocus = (): void => {
    if (args.getDelayMs() !== null) {
      reconcileVisibility()
    }
  }

  runAndSchedule('install')
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', reconcileFocus)
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcileVisibility)
  }

  const cleanup = (): void => {
    disposed = true
    clearScheduledPoll()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', reconcileFocus)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcileVisibility)
    }
  }
  return Object.assign(cleanup, {
    refresh: () => runAndSchedule('refresh'),
    // The delay policy changed: arm or disarm the next tick without running anything now.
    replan: () => {
      if (!inFlight) {
        schedulePoll()
      }
    }
  })
}
