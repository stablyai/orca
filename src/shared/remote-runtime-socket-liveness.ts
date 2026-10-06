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
// Why: a request may be the user's first act after sleep or a Wi-Fi change; if nothing comes back
// soon after it, probe so a dead return path surfaces in seconds instead of after the request timeout.
export const REMOTE_RUNTIME_SOCKET_SEND_PROBE_QUIET_MS = 2_000
export const REMOTE_RUNTIME_SOCKET_SEND_PROBE_TIMEOUT_MS = 5_000

export type RemoteRuntimeSocketLivenessOptions = {
  pingIntervalMs?: number
  livenessTimeoutMs?: number
  sendProbeQuietMs?: number
  sendProbeTimeoutMs?: number
}

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  /** Probes the socket if nothing arrives soon after a send; at most one probe is outstanding. */
  noteOutbound: () => void
  stop: () => void
}

export function startRemoteRuntimeSocketLiveness(args: {
  ping: () => void
  onDead: () => void
  options?: RemoteRuntimeSocketLivenessOptions
  now?: () => number
}): RemoteRuntimeSocketLivenessMonitor {
  const now = args.now ?? Date.now
  const pingIntervalMs = args.options?.pingIntervalMs ?? REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS
  const livenessTimeoutMs =
    args.options?.livenessTimeoutMs ?? REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS
  const sendProbeQuietMs =
    args.options?.sendProbeQuietMs ?? REMOTE_RUNTIME_SOCKET_SEND_PROBE_QUIET_MS
  const sendProbeTimeoutMs =
    args.options?.sendProbeTimeoutMs ?? REMOTE_RUNTIME_SOCKET_SEND_PROBE_TIMEOUT_MS
  let lastTickAt = now()
  let probeSentAt: number | null = null
  let sendProbe: ReturnType<typeof setTimeout> | null = null
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
  unrefTimer(timer)

  function stop(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
    clearSendProbe()
  }

  function clearSendProbe(): void {
    if (sendProbe !== null) {
      clearTimeout(sendProbe)
      sendProbe = null
    }
  }

  function noteOutbound(): void {
    if (stopped || sendProbe !== null) {
      return
    }
    // Why wait first: a reply within the quiet window proves the path, so healthy sends never ping.
    sendProbe = setTimeout(() => {
      sendProbe = null
      if (!stopped) {
        startSendProbe()
      }
    }, sendProbeQuietMs)
    unrefTimer(sendProbe)
  }

  function startSendProbe(): void {
    const sentAt = now()
    tryPing()
    sendProbe = setTimeout(() => {
      sendProbe = null
      if (stopped) {
        return
      }
      // Why: a deadline that fired late (sleep, throttling) never gave the socket its window.
      if (now() - sentAt > sendProbeTimeoutMs * 1.5) {
        startSendProbe()
        return
      }
      stop()
      args.onDead()
    }, sendProbeTimeoutMs)
    unrefTimer(sendProbe)
  }

  function tryPing(): void {
    try {
      args.ping()
    } catch {
      // Why: ping() can throw while a socket is mid-teardown; the probe deadline still settles it.
    }
  }

  return {
    noteActivity: () => {
      probeSentAt = null
      clearSendProbe()
    },
    noteOutbound,
    stop
  }
}

function unrefTimer(timer: unknown): void {
  // Why unknown: mobile typechecks shared code with DOM timer types, where timers are numbers.
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref()
  }
}
