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
        // Why: all mounted relative-time labels at this cadence share one
        // visibility-gated timer. installWindowVisibilityInterval runs tick
        // immediately on (re)start — so remounted or newly-visible labels catch
        // up at once — and pauses the interval while the window is hidden, so
        // backgrounded agent rows stop re-rendering for ticks no one can see.
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

// Why: a disabled caller must not hold the shared interval open or re-render on
// its ticks. It still reads the shared snapshot, so it can never show a value
// older than an enabled caller at the same cadence.
const subscribeWhileDisabled = (): (() => void) => () => {}

// Why: relative timestamps drift once mounted. A coarse tick keeps the "Xm
// ago" labels honest without burning a render every second.
//
// Hoisted to a shared hook so container components (e.g.
// WorktreeCardAgents) can own a single tick and thread `now` down to every
// DashboardAgentRow. Previously each row instantiated its own interval,
// which meant N timers firing at staggered mount times for N rows on
// screen — turning one logical tick into N independent React commits.
//
// Pass `enabled: false` while a surface cannot show the value; joining a clock
// another caller already keeps running yields a snapshot at most `intervalMs`
// old, so pick the coarsest cadence the label can tolerate.
export function useNow(intervalMs: number, enabled = true): number {
  const clock = getSharedNowClock(intervalMs)
  return useSyncExternalStore(
    enabled ? clock.subscribe : subscribeWhileDisabled,
    clock.getSnapshot,
    clock.getSnapshot
  )
}
