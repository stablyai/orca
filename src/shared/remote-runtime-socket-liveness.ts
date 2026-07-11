// Why: a half-open tunnel (devtunnel/NAT drop) never delivers a ws `close`,
// so edge-triggered reconnect logic on the client side never fires while the
// server has long since reaped its end (#7718/#7489). This monitor gives
// client sockets a level-based liveness check: send a probe after inbound
// silence, then declare the socket dead only if that probe gets a full
// unanswered window, so the existing close/reconnect path can run.

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

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  stop: () => void
}

export function isRemoteRuntimeLivenessTickDelayed(args: {
  now: number
  lastTickAt: number
  intervalMs: number
}): boolean {
  const elapsed = args.now - args.lastTickAt
  return elapsed < 0 || elapsed >= args.intervalMs * 2
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
  let lastActivityAt = now()
  let lastTickAt = lastActivityAt
  let probeSentAt: number | null = null
  let stopped = false

  const runTick = (): void => {
    if (stopped) {
      return
    }
    const current = now()
    if (
      isRemoteRuntimeLivenessTickDelayed({
        now: current,
        lastTickAt,
        intervalMs: pingIntervalMs
      })
    ) {
      lastTickAt = current
      lastActivityAt = current
      probeSentAt = null
      return
    }
    lastTickAt = current
    if (probeSentAt !== null && current - probeSentAt >= livenessTimeoutMs) {
      stop()
      args.onDead()
      return
    }
    if (probeSentAt === null && current - lastActivityAt >= livenessTimeoutMs) {
      try {
        args.ping()
        probeSentAt = current
      } catch {
        // Why: ping() can throw while a socket is mid-teardown; the close path
        // or the unanswered probe window decides the socket's fate.
      }
    }
  }

  const timer = setInterval(runTick, pingIntervalMs)
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
  }

  return {
    noteActivity: () => {
      lastActivityAt = now()
      probeSentAt = null
    },
    stop
  }
}
