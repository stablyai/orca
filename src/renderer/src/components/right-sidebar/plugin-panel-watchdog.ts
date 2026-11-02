import {
  PANEL_WATCHDOG_PING_INTERVAL_MS,
  PANEL_WATCHDOG_PONG_TIMEOUT_MS
} from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'

/** Ping/pong deadlines mark unresponsive panels; busy-loop containment requires a separate Chromium renderer, gated by Electron tests. */

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
    // Pause hidden pings; use park visibility because macOS can wedge raw visibilityState at hidden indefinitely.
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
      // StrictMode restarts effects after cleanup; stopped watchdogs must support reuse.
      generation += 1
      active = true
      awaitedPingId = null
      clearDeadline()
      pingTimer = setInterval(ping, pingIntervalMs)
      unsubscribeVisibility?.()
      // Ping immediately on resume instead of waiting out the interval that kept ticking while hidden.
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
