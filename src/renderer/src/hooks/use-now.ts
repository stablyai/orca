import { useSyncExternalStore } from 'react'
import {
  installWindowVisibilityInterval,
  type WindowVisibilityIntervalTimer
} from '@/lib/window-visibility-interval'

type ClockDeps = {
  now: () => number
  setInterval: (callback: () => void, intervalMs: number) => WindowVisibilityIntervalTimer
  clearInterval: (handle: WindowVisibilityIntervalTimer) => void
}

type SharedNowClock = {
  getSnapshot: () => number
  subscribe: (listener: () => void) => () => void
}

const nowClocks = new Map<number, SharedNowClock>()

export function createSharedNowClock(
  intervalMs: number,
  deps: ClockDeps = {
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle)
  }
): SharedNowClock {
  let now = deps.now()
  let stopInterval: (() => void) | null = null
  const listeners = new Set<() => void>()

  const tick = (): void => {
    now = deps.now()
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    getSnapshot: () => now,
    subscribe: (listener) => {
      listeners.add(listener)
      if (!stopInterval) {
        // Share one visibility-gated timer per cadence; restart ticks immediately to catch up remounted/revealed labels without hidden-window churn.
        stopInterval = installWindowVisibilityInterval({
          run: tick,
          intervalMs,
          setIntervalFn: deps.setInterval,
          clearIntervalFn: deps.clearInterval
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stopInterval) {
          stopInterval()
          stopInterval = null
        }
      }
    }
  }
}

function getSharedNowClock(intervalMs: number): SharedNowClock {
  let clock = nowClocks.get(intervalMs)
  if (!clock) {
    clock = createSharedNowClock(intervalMs)
    nowClocks.set(intervalMs, clock)
  }
  return clock
}

// Disabled callers read the shared frozen snapshot without retaining its timer or subscribing to ticks.
const subscribeWhileDisabled = (): (() => void) => () => {}

/** Share coarse label ticks across rows to avoid N timers/commits. Disabled callers activate through a passive effect and may first read arbitrarily stale time; deadlines must use Date.now() in the acting effect. */
export function useNow(intervalMs: number, enabled = true): number {
  const clock = getSharedNowClock(intervalMs)
  return useSyncExternalStore(
    enabled ? clock.subscribe : subscribeWhileDisabled,
    clock.getSnapshot,
    clock.getSnapshot
  )
}
