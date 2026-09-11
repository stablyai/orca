import type { ClientOptions } from 'ws'

/**
 * Connect-phase bound for the Node-side remote-runtime WebSocket transports.
 *
 * Why: a host that is powered off or firewalled black-holes the TCP SYN, so the
 * socket neither opens nor errors. Without this the only bound is the caller's
 * whole-request timeout (60s in the CLI), which reads to the user as a frozen
 * terminal. `ws` applies `handshakeTimeout` across TCP connect *and* the HTTP
 * upgrade, so one option covers both silent stalls.
 *
 * The value matches `CONNECT_TIMEOUT_MS` in
 * `src/renderer/src/web/web-runtime-connection-transport.ts`, which already
 * bounded the browser transport; this brings the Node transports in line.
 */
export const REMOTE_RUNTIME_CONNECT_TIMEOUT_MS = 12_000

/** The `ws` message for an elapsed `handshakeTimeout`; matched, never thrown by us. */
const WS_HANDSHAKE_TIMEOUT_MESSAGE = 'Opening handshake has timed out'

export function remoteRuntimeConnectOptions<TOptions extends ClientOptions>(
  options?: TOptions,
  connectTimeoutMs: number = REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
): TOptions & { handshakeTimeout: number } {
  return {
    ...(options ?? ({} as TOptions)),
    handshakeTimeout: connectTimeoutMs
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
export function remoteRuntimeConnectFailureMessage(
  error: unknown,
  endpoint: string,
  connectTimeoutMs: number = REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
): string {
  if (!isRemoteRuntimeConnectTimeout(error)) {
    return 'Could not connect to the remote Orca runtime.'
  }
  return (
    `Could not reach the remote Orca runtime at ${endpoint} within ${connectTimeoutMs}ms. ` +
    'The host did not answer, so anything running on it is unverifiable.'
  )
}
