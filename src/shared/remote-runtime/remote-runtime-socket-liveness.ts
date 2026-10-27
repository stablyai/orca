// Half-open tunnels never emit close, preventing reconnect (#7718/#7489). Ping periodically and require any inbound activity
// so existing close/reconnect paths run. RFC 6455 control pings work with older embedded ws servers too.

export const REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS = 10_000
// Detect loss just under two server heartbeat periods (15s), aligning with the host reaper.
export const REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS = 25_000

export type RemoteRuntimeSocketLivenessOptions = {
  pingIntervalMs?: number
  livenessTimeoutMs?: number
}

// Resume probes start liveness immediately on OPEN-but-dead sockets; this deadline only re-pings because relayed/lossy paths may recover later.
export const REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS = 8_000
// Why: inbound data this recent suggests the path survived; the regular keepalive still covers a miss.
export const REMOTE_RUNTIME_SOCKET_RESUME_PROBE_RECENT_ACTIVITY_MS = 3_000

/** Why the monitor gave up: the regular keepalive window, or one a wake/online probe started. */
export type RemoteRuntimeSocketDeathCause = 'keepalive_timeout' | 'wake_probe_timeout'

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  /** A pong arrived; also measures round-trip time against the oldest unanswered ping. */
  notePong: () => void
  /** Ping now; declare the socket dead unless anything arrives within the liveness window. */
  probeNow: (deadlineMs?: number) => void
  stop: () => void
}

const activeMonitors = new Set<RemoteRuntimeSocketLivenessMonitor>()

/** Probe every live remote-runtime socket in this process, e.g. on OS resume or network change. */
export function probeAllRemoteRuntimeSocketsNow(
  deadlineMs = REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS
): number {
  const monitors = Array.from(activeMonitors)
  for (const monitor of monitors) {
    monitor.probeNow(deadlineMs)
  }
  return monitors.length
}

export function startRemoteRuntimeSocketLiveness(args: {
  /** Returns false when nothing was sent, e.g. the socket is still connecting. */
  ping: () => boolean
  onDead: (cause: RemoteRuntimeSocketDeathCause) => void
  onRoundTrip?: (rttMs: number) => void
  options?: RemoteRuntimeSocketLivenessOptions
  now?: () => number
}): RemoteRuntimeSocketLivenessMonitor {
  const now = args.now ?? Date.now
  const pingIntervalMs = args.options?.pingIntervalMs ?? REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS
  const livenessTimeoutMs =
    args.options?.livenessTimeoutMs ?? REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS
  let lastTickAt = now()
  let probeSentAt: number | null = null
  let activitySinceResumeProbe = false
  let lastActivityAt: number | null = null
  let unansweredPingAt: number | null = null
  let resumeProbeTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) {
      return
    }
    const tickAt = now()
    const tickElapsedMs = tickAt - lastTickAt
    lastTickAt = tickAt
    // Why: sleep and background throttling age sockets without giving them a chance to answer.
    if (tickElapsedMs < 0 || tickElapsedMs > pingIntervalMs * 1.5) {
      probeSentAt = tickAt
      // Why: a pong for a ping sent before the stall would report the stall as round-trip time.
      unansweredPingAt = null
      tryPing()
      return
    }
    if (probeSentAt !== null && tickAt - probeSentAt > livenessTimeoutMs) {
      stop()
      args.onDead('keepalive_timeout')
      return
    }
    if (probeSentAt === null) {
      probeSentAt = tickAt
      tryPing()
    }
  }, pingIntervalMs)
  // Why: mobile typechecks shared code with DOM timer types where unref is absent.
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') {
    unrefable.unref()
  }

  function stop(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
    if (resumeProbeTimer !== null) {
      clearTimeout(resumeProbeTimer)
      resumeProbeTimer = null
    }
    activeMonitors.delete(monitor)
  }

  function probeNow(deadlineMs = REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS): void {
    if (stopped || resumeProbeTimer !== null) {
      return
    }
    const probedAt = now()
    const sinceActivityMs = lastActivityAt === null ? null : probedAt - lastActivityAt
    if (
      sinceActivityMs !== null &&
      sinceActivityMs >= 0 &&
      sinceActivityMs < REMOTE_RUNTIME_SOCKET_RESUME_PROBE_RECENT_ACTIVITY_MS
    ) {
      return
    }
    activitySinceResumeProbe = false
    // Why: a ping left from before the wake or network change would report the outage as RTT.
    unansweredPingAt = null
    // Why: a socket still connecting has no path to probe yet; a deadline with no ping could kill it mid-handshake.
    if (!tryPing()) {
      return
    }
    // Why: the probe restarts the keepalive window, so an older unanswered ping cannot cut it short.
    probeSentAt = probedAt
    const deathDelayMs = Math.max(livenessTimeoutMs - deadlineMs, deadlineMs)
    armResumeProbeTimer(probedAt, deadlineMs, deadlineMs, () => {
      // Why: a missed resume probe is suspect, not dead; a second ping covers a first one lost mid-reroute.
      tryPing()
      armResumeProbeTimer(now(), deathDelayMs, deadlineMs, () => {
        stop()
        args.onDead('wake_probe_timeout')
      })
    })
  }

  function armResumeProbeTimer(
    armedAt: number,
    delayMs: number,
    probeDeadlineMs: number,
    onSilent: () => void
  ): void {
    resumeProbeTimer = setTimeout(() => {
      resumeProbeTimer = null
      if (stopped || activitySinceResumeProbe) {
        return
      }
      // Why: a late timer means this process slept or stalled, so replies may still be queued; probe afresh.
      const elapsedMs = now() - armedAt
      if (elapsedMs < 0 || elapsedMs > delayMs * 1.5) {
        probeNow(probeDeadlineMs)
        return
      }
      onSilent()
    }, delayMs)
    // Why: mobile typechecks shared code with DOM timer types where unref is absent.
    const timer: unknown = resumeProbeTimer
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  function tryPing(): boolean {
    try {
      const sent = args.ping()
      if (sent && unansweredPingAt === null) {
        unansweredPingAt = now()
      }
      return sent
    } catch {
      // Why: ping() can throw while a socket is mid-teardown; the probe deadline still settles it.
      return true
    }
  }

  function noteActivity(): void {
    probeSentAt = null
    activitySinceResumeProbe = true
    lastActivityAt = now()
  }

  const monitor: RemoteRuntimeSocketLivenessMonitor = {
    noteActivity,
    notePong: () => {
      noteActivity()
      const rttMs = unansweredPingAt === null ? null : now() - unansweredPingAt
      unansweredPingAt = null
      if (rttMs !== null && rttMs >= 0) {
        args.onRoundTrip?.(rttMs)
      }
    },
    probeNow,
    stop
  }
  activeMonitors.add(monitor)
  return monitor
}
