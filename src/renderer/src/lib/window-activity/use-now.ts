import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  installWindowVisibilityInterval,
  type WindowVisibilityIntervalTimer
} from '@/lib/window-activity/window-visibility-interval'

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
        // Why: with no subscribers the snapshot is frozen at the last tick; refresh it so the first subscriber's re-read is current even while hidden.
        now = deps.now()
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
  return useNowSnapshot(intervalMs, readNow, enabled)
}

/** useNow for countdown labels: never older than the mount, as a per-component Date.now() state was; an idle shared clock can hold an hours-old tick. */
export function useNowFromMount(intervalMs: number, enabled = true): number {
  const [mountedAt] = useState(() => Date.now())
  return Math.max(mountedAt, useNow(intervalMs, enabled))
}

const readNow = (now: number): number => now

export function useNowSnapshot<T>(
  intervalMs: number,
  select: (now: number) => T,
  enabled = true
): T {
  const clock = getSharedNowClock(intervalMs)
  const getSnapshot = useCallback(() => select(clock.getSnapshot()), [clock, select])
  return useSyncExternalStore(
    enabled ? clock.subscribe : subscribeWhileDisabled,
    getSnapshot,
    getSnapshot
  )
}
