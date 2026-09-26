import type { ClientOptions } from 'ws'
import { endpointForDisplay } from './remote-pairing-endpoint'

/**
 * Connect-phase bound for the Node-side remote-runtime WebSocket transports.
 *
 * Why: a host that is powered off or firewalled black-holes the TCP SYN, so the
 * socket neither opens nor errors. Without this the only bound is the caller's
 * whole-request timeout (60s in the CLI), which reads to the user as a frozen
 * terminal.
 *
 * `ws` maps `handshakeTimeout` onto the `http.request` `timeout`, which Node
 * implements as a socket *inactivity* timer: armed before DNS/connect and reset
 * by connect completion and by every response chunk. So this is "12s with no
 * bytes at all", not a 12s wall-clock budget — a slow-but-answering host is not
 * cut off, while a silent one fails promptly.
 *
 * The value matches `CONNECT_TIMEOUT_MS` in
 * `src/renderer/src/web/web-runtime-connection-transport.ts`, which already
 * bounded the browser transport (a wall-clock budget there).
 *
 * Why this is not the duplicate bound that was removed from the relay control
 * socket: there, both timers were 15s and the class one was wall-clock from
 * construction, so the transport timer could never win and covered nothing.
 * Here the whole-request timer is 15s (60s in the CLI) and measures the RPC,
 * not the connect, and this one is inactivity-based and strictly tighter — so
 * it is the bound that actually reports an unanswered host, with the specific
 * message the recovery classifiers need, rather than a generic RPC timeout.
 */
export const REMOTE_RUNTIME_CONNECT_TIMEOUT_MS = 12_000

/** The `ws` message for an elapsed `handshakeTimeout`; matched, never thrown by us. */
export const WS_HANDSHAKE_TIMEOUT_MESSAGE = 'Opening handshake has timed out'

/**
 * Every connect failure starts with this phrase. It is load-bearing, not copy:
 * `RECOVERABLE_MESSAGE_FRAGMENTS` and `REMOTE_RUNTIME_UNREACHABLE_RE` both key
 * on it, and the subscribe IPC boundary drops the error `code`, so on that path
 * the phrase is the only thing keeping the terminal pane retrying instead of
 * dead-ending. Reword it and both gates go silent.
 */
export const REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE = 'Could not connect to the remote Orca runtime'

export function remoteRuntimeConnectOptions<TOptions extends ClientOptions>(
  options?: TOptions,
  connectTimeoutMs?: number
): TOptions & { handshakeTimeout: number } {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the empty default stands in for an absent TOptions; every property it could carry is optional, and the spread below is the only use.
    ...(options ?? ({} as TOptions)),
    // Why: `ws` and `net` both gate on a truthy timeout, so 0 (or a non-finite value)
    // would silently leave the connect unbounded — the defect this module exists to fix.
    handshakeTimeout:
      typeof connectTimeoutMs === 'number' &&
      Number.isFinite(connectTimeoutMs) &&
      connectTimeoutMs > 0
        ? connectTimeoutMs
        : REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
  }
}

export function isRemoteRuntimeConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === WS_HANDSHAKE_TIMEOUT_MESSAGE
}

/**
 * Why: per `docs/reference/ssh-execution-boundary.md`, loss of contact is never
 * evidence that remote work stopped. This message says the host did not answer
 * and stops there — it must not imply the host's terminals are gone.
 */
export function remoteRuntimeConnectFailureMessage(error: unknown, endpoint: string): string {
  if (!isRemoteRuntimeConnectTimeout(error)) {
    return `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE}.`
  }
  // Why no elapsed time: handshakeTimeout is an inactivity timer, so a `wss://` host that
  // completes TCP and then goes silent re-arms it once and fails at ~2x the bound. Naming a
  // number here would be wrong in that case; the endpoint is the actionable part anyway.
  return (
    `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE} at ${endpointForDisplay(endpoint)}: the host ` +
    'did not answer, so anything running on it is unverifiable.'
  )
}
