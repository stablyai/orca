/** Retry timers outlive their requests; dispose cancels them, and manual Retry replaces pending timers rather than racing them. */

import type { AutomationHostCache } from './automation-host-cache'
import { classifyAutomationHostQueryError } from './automation-host-cache-error'
import type { PlannedAutomationHostTarget } from './automation-host-scheduler-plan'

export type AutomationHostRetrySchedule = {
  /** False when the fence rejected the failure, which is a discard like any other. */
  record: (target: PlannedAutomationHostTarget, error: unknown) => boolean
  cancel: (stableKey: string) => void
  dispose: () => void
}

export type AutomationHostRetryScheduleOptions = {
  cache: AutomationHostCache
  now: () => number
  random?: () => number
  /** A hidden window records the failure but arms nothing; the next visit re-plans it. */
  isVisible: () => boolean
  scheduleRetry: (run: () => void, delayMs: number) => () => void
  /** Starts the next attempt; the scheduler owns how that request is sent. */
  retry: (target: PlannedAutomationHostTarget) => void
}

export function createAutomationHostRetrySchedule(
  options: AutomationHostRetryScheduleOptions
): AutomationHostRetrySchedule {
  const timers = new Map<string, () => void>()

  const cancel = (stableKey: string): void => {
    timers.get(stableKey)?.()
    timers.delete(stableKey)
  }

  return {
    cancel,
    record: (target, error) => {
      const attempt = (options.cache.getByKey(target.stableKey)?.attempt ?? 0) + 1
      const queryError = classifyAutomationHostQueryError(error, {
        attempt,
        now: options.now(),
        random: options.random
      })
      if (!options.cache.fail(target.fence, queryError)) {
        return false
      }
      if (!queryError.retryable || !options.isVisible()) {
        return true
      }
      const delay = Math.max(0, (queryError.retryAt ?? options.now()) - options.now())
      cancel(target.stableKey)
      timers.set(
        target.stableKey,
        options.scheduleRetry(() => {
          timers.delete(target.stableKey)
          options.retry(target)
        }, delay)
      )
      return true
    },
    dispose: () => {
      for (const stop of timers.values()) {
        stop()
      }
      timers.clear()
    }
  }
}
