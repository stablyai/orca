import {
  PANEL_WATCHDOG_PING_INTERVAL_MS,
  PANEL_WATCHDOG_PONG_TIMEOUT_MS
} from '../../../../shared/plugins/plugin-panel-bridge'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'

/**
 * Panel responsiveness watchdog: pings the sandboxed frame on an interval
 * and demotes the panel to an errored badge when a pong misses its deadline.
 * The busy-loop guarantee depends on Chromium assigning the sandboxed frame
 * a separate renderer, which the Electron containment test gates explicitly.
 * Pure timer logic keeps deadline behavior deterministic in unit tests.
 */

export type PanelWatchdogOptions = {
  sendPing: (pingId: number) => void
  onUnresponsive: () => void
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

export type PanelWatchdog = {
  start(): void
  stop(): void
  handlePong(pingId: number): void
}

export function createPanelWatchdog(options: PanelWatchdogOptions): PanelWatchdog {
  const pingIntervalMs = options.pingIntervalMs ?? PANEL_WATCHDOG_PING_INTERVAL_MS
  const pongTimeoutMs = options.pongTimeoutMs ?? PANEL_WATCHDOG_PONG_TIMEOUT_MS
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  let nextPingId = 0
  let awaitedPingId: number | null = null
  let active = false
  let generation = 0
  let unsubscribeVisibility: (() => void) | null = null

  const clearDeadline = (): void => {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
      deadlineTimer = null
    }
  }

  const ping = (): void => {
    if (!active || awaitedPingId !== null) {
      // A ping is already outstanding; its deadline will fire first.
      return
    }
    // Why: an "unresponsive" badge on a hidden panel is invisible — detect it on resume
    // before the user can interact. getWindowParkVisible, not raw visibilityState: macOS can
    // wedge the latter at 'hidden' with no further visibilitychange, which would park the
    // watchdog for the rest of the session.
    if (!getWindowParkVisible()) {
      return
    }
    awaitedPingId = nextPingId++
    options.sendPing(awaitedPingId)
    const deadlineGeneration = generation
    deadlineTimer = setTimeout(() => {
      if (active && generation === deadlineGeneration && awaitedPingId !== null) {
        active = false
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = null
        }
        deadlineTimer = null
        awaitedPingId = null
        options.onUnresponsive()
      }
    }, pongTimeoutMs)
  }

  return {
    start() {
      if (active) {
        return
      }
      // React StrictMode intentionally runs effect setup → cleanup → setup.
      // A stopped watchdog must be reusable by the second real setup.
      generation += 1
      active = true
      awaitedPingId = null
      clearDeadline()
      pingTimer = setInterval(ping, pingIntervalMs)
      unsubscribeVisibility?.()
      // Why: the interval is never stopped, so without this a resume waits out the remaining
      // interval before the first ping the hidden window skipped.
      unsubscribeVisibility = subscribeWindowParkVisibility(() => {
        if (getWindowParkVisible()) {
          ping()
        }
      })
      ping()
    },
    stop() {
      active = false
      generation += 1
      unsubscribeVisibility?.()
      unsubscribeVisibility = null
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      clearDeadline()
      awaitedPingId = null
    },
    handlePong(pingId) {
      if (active && pingId === awaitedPingId) {
        awaitedPingId = null
        clearDeadline()
      }
    }
  }
}
