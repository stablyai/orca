import type { ClientOptions } from 'ws'

/** Bound silent Node WebSocket connects before the whole-RPC timeout (15s, or 60s in the CLI).
 * Node resets this inactivity timer on connect and response chunks; it is not a wall-clock budget.
 * Matches the browser’s 12s value, whose timer is wall-clock. */
export const REMOTE_RUNTIME_CONNECT_TIMEOUT_MS = 12_000

/** The `ws` message for an elapsed `handshakeTimeout`; matched, never thrown by us. */
export const WS_HANDSHAKE_TIMEOUT_MESSAGE = 'Opening handshake has timed out'

/** Keep this phrase: code-less subscribe IPC relies on RECOVERABLE_MESSAGE_FRAGMENTS and REMOTE_RUNTIME_UNREACHABLE_RE. */
export const REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE = 'Could not connect to the remote Orca runtime'

export function remoteRuntimeConnectOptions<TOptions extends ClientOptions>(
  options?: TOptions,
  connectTimeoutMs?: number
): TOptions & { handshakeTimeout: number } {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the empty default stands in for an absent TOptions; every property it could carry is optional, and the spread below is the only use.
    ...(options ?? ({} as TOptions)),
    // Both ws and net treat zero as unbounded; reject invalid overrides.
    handshakeTimeout:
      typeof connectTimeoutMs === 'number' &&
      Number.isFinite(connectTimeoutMs) &&
      connectTimeoutMs > 0
        ? connectTimeoutMs
        : REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
  }
}

/** Exclude URL-legal underscores: hosts containing terminal_gone-like tokens can fool downstream substring classifiers. */
const DISPLAYABLE_ENDPOINT_HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i

/** Pairing endpoints are untrusted; show only scheme and a host that cannot smuggle diagnostic verdicts. */
function endpointForDisplay(endpoint: string): string {
  try {
    const { protocol, host } = new URL(endpoint)
    return DISPLAYABLE_ENDPOINT_HOST_RE.test(host) ? `${protocol}//${host}` : 'the paired endpoint'
  } catch {
    return 'the paired endpoint'
  }
}

export function isRemoteRuntimeConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === WS_HANDSHAKE_TIMEOUT_MESSAGE
}

/** Loss of contact leaves remote work unverifiable; never imply its terminals stopped (ssh-execution-boundary.md). */
export function remoteRuntimeConnectFailureMessage(error: unknown, endpoint: string): string {
  if (!isRemoteRuntimeConnectTimeout(error)) {
    return `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE}.`
  }
  // Do not name an elapsed bound: wss can rearm the inactivity timer after TCP connects and take roughly twice as long.
  return (
    `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE} at ${endpointForDisplay(endpoint)}: the host ` +
    'did not answer, so anything running on it is unverifiable.'
  )
}
