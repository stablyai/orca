import {
  PANEL_WATCHDOG_PING_INTERVAL_MS,
  PANEL_WATCHDOG_PONG_TIMEOUT_MS
} from '../../../../shared/plugins/plugin-panel-bridge'

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
      ping()
    },
    stop() {
      active = false
      generation += 1
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
