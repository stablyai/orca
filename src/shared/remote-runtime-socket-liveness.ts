// Why: a half-open tunnel (devtunnel/NAT drop) never delivers a ws `close`,
// so edge-triggered reconnect logic on the client side never fires while the
// server has long since reaped its end (#7718/#7489). This monitor gives
// client sockets a level-based liveness check: ping on a cadence and declare
// the socket dead when no inbound traffic (frames, pings, or pongs) arrives
// within the window, so the existing close/reconnect path can run.

// Why: pings ride the RFC 6455 control-frame layer, which every supported
// server (and the `ws` package it embeds) answers automatically — this stays
// backward compatible with old servers that predate client-side liveness.
export const REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS = 10_000
// Why: just under two server heartbeat periods (15s), so a dead link is
// detected on a similar horizon to the server's own ping/terminate reaper.
export const REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS = 25_000

export type RemoteRuntimeSocketLivenessOptions = {
  pingIntervalMs?: number
  livenessTimeoutMs?: number
}

// Why: after sleep or a network change a socket can read OPEN while its path is gone; the normal
// cadence needs ~30-40 s to prove that. A resume probe settles it in one short, explicit window.
export const REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS = 8_000

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  /** Ping now; declare the socket dead unless anything arrives within `deadlineMs`. */
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
  onDead: () => void
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
      tryPing()
      return
    }
    if (probeSentAt !== null && tickAt - probeSentAt > livenessTimeoutMs) {
      stop()
      args.onDead()
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
    activitySinceResumeProbe = false
    // Why: a socket still connecting has no path to probe yet; a deadline with no ping could kill it mid-handshake.
    if (!tryPing()) {
      return
    }
    resumeProbeTimer = setTimeout(() => {
      resumeProbeTimer = null
      if (!stopped && !activitySinceResumeProbe) {
        stop()
        args.onDead()
      }
    }, deadlineMs)
    // Why: mobile typechecks shared code with DOM timer types where unref is absent.
    if (
      typeof resumeProbeTimer === 'object' &&
      'unref' in resumeProbeTimer &&
      typeof resumeProbeTimer.unref === 'function'
    ) {
      resumeProbeTimer.unref()
    }
  }

  function tryPing(): boolean {
    try {
      return args.ping()
    } catch {
      // Why: ping() can throw while a socket is mid-teardown; the probe deadline still settles it.
      return true
    }
  }

  const monitor: RemoteRuntimeSocketLivenessMonitor = {
    noteActivity: () => {
      probeSentAt = null
      activitySinceResumeProbe = true
    },
    probeNow,
    stop
  }
  activeMonitors.add(monitor)
  return monitor
}
