import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime-shared-control-types'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'

export const RUNTIME_HOST_STATUS_CHANNEL = 'runtimeEnvironments:statusChanged'

/** Local client state; never exchanged with the paired host. */
export type RuntimeHostStatusSnapshot = {
  environmentId: string
  pairingRevision: number
  sequence: number
  checkedAt: number
  status: RuntimeStatus | null
  verification: 'checking' | 'verified' | 'unavailable' | 'blocked'
  transport: 'unknown' | 'connecting' | 'ready' | 'disconnected'
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
  retired?: true
}

/**
 * One client-side record of a host's last status probe: the projected `status`, and the
 * `snapshot` evidence for what that projection is worth. Declared once rather than duck-typed
 * per consumer — every field added here has been optional, so a local structural copy keeps
 * typechecking against the store while silently missing whatever landed after it was written.
 */
export type RuntimeEnvironmentStatus = {
  snapshot?: RuntimeHostStatusSnapshot
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  appVersion?: string | null
  checkedAt: number
  /**
   * Identity of the connection: which socket epoch retained state belongs to. Every cache key,
   * stamp and settle fence compares this, so advancing it invalidates the session mirror.
   */
  connectionGeneration?: number
  /**
   * Edge count of "the host answered again after we lost contact". A resubscribe trigger only —
   * the streams died with the transport and nothing else revives them. Never an identity, a cache
   * key, or a fence: that is `connectionGeneration`, and a flap must not move it (#19647).
   */
  hostContactEpoch?: number
}

/**
 * The last status the host actually answered with. The snapshot retains it across an
 * unverifiable probe, so this survives a loss of contact; the entry's own `status` does not.
 */
export function lastVerifiedRuntimeStatus<Status = RuntimeStatus>(
  entry: { status?: Status | null; snapshot?: { status: Status | null } | null } | null | undefined
): Status | null {
  return entry?.snapshot?.status ?? entry?.status ?? null
}

/**
 * The host's own verdict that this pairing is over: retired by an explicit disconnect, or
 * refused — auth rejected or protocol mismatch, which stops every retry for good. Positive
 * evidence, unlike a lost transport, so this is the only state that may withdraw a fact the
 * host already gave us (docs/reference/ssh-execution-boundary.md).
 */
export function isRuntimeHostContactRevoked(
  entry:
    | { snapshot?: Pick<RuntimeHostStatusSnapshot, 'verification' | 'retired'> | null }
    | null
    | undefined
): boolean {
  const snapshot = entry?.snapshot
  return Boolean(snapshot && (snapshot.retired || snapshot.verification === 'blocked'))
}

export type RuntimeHostStatusResponse = RuntimeRpcResponse<RuntimeStatus>

export function runtimeHostStatusFailure(code: string, message: string): RuntimeRpcFailure {
  return { id: 'status.get', ok: false, error: { code, message } }
}

export function runtimeHostStatusError(error: unknown): RuntimeRpcFailure {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'runtime_unavailable'
  return runtimeHostStatusFailure(code, error instanceof Error ? error.message : String(error))
}

export function isRuntimeHostStatusBlocked(response: RuntimeRpcFailure): boolean {
  return [
    'unauthorized',
    'forbidden',
    'invalid_argument',
    'invalid_runtime_response',
    'protocol_version_mismatch',
    'method_not_found',
    'unsupported_method'
  ].includes(response.error.code)
}
