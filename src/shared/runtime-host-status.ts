import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'

export const RUNTIME_HOST_STATUS_CHANNEL = 'runtimeEnvironments:statusChanged'

/** Why a host refused this client: its pairing was revoked, or the versions cannot talk. */
export type RuntimeHostBlockedReason = 'access-revoked' | 'incompatible'

/** Local client state; never exchanged with the paired host. */
export type RuntimeHostStatusSnapshot = {
  environmentId: string
  pairingRevision: number
  sequence: number
  checkedAt: number
  status: RuntimeStatus | null
  verification: 'checking' | 'verified' | 'unavailable' | 'blocked'
  /** Set only while a refused status probe holds `verification` at blocked. */
  blockedReason?: RuntimeHostBlockedReason
  transport: 'unknown' | 'connecting' | 'ready' | 'disconnected'
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
  retired?: true
}

/** Share projected status and its snapshot evidence; optional fields let structural copies silently miss new semantics. */
export type RuntimeEnvironmentStatus = {
  snapshot?: RuntimeHostStatusSnapshot
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  appVersion?: string | null
  checkedAt: number
  /** Connection identity fences caches/stamps/settlement; advancing it invalidates the session mirror. */
  connectionGeneration?: number
  /** Resubscribe edge after contact returns, never cache/fence identity: flaps must not move connectionGeneration (#19647). */
  hostContactEpoch?: number
}

/** The store entry a status snapshot stands for: its status counts only while verified and current. */
export function runtimeEnvironmentStatusFromSnapshot(
  snapshot: RuntimeHostStatusSnapshot
): RuntimeEnvironmentStatus {
  const status = snapshot.verification === 'verified' && !snapshot.retired ? snapshot.status : null
  return {
    snapshot,
    checkedAt: snapshot.checkedAt,
    status:
      status && snapshot.remoteControl
        ? { ...status, remoteControl: snapshot.remoteControl }
        : status,
    remoteControl: snapshot.remoteControl
  }
}

/** The snapshot keeps the last answered status through unverifiable probes; projected entry.status does not. */
export function lastVerifiedRuntimeStatus<Status = RuntimeStatus>(
  entry: { status?: Status | null; snapshot?: { status: Status | null } | null } | null | undefined
): Status | null {
  return entry?.snapshot?.status ?? entry?.status ?? null
}

/** Only explicit retirement or auth/protocol refusal withdraws prior host facts; transport loss cannot prove them gone
 * (docs/reference/ssh-execution-boundary.md). */
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

const ACCESS_REVOKED_CODES = ['unauthorized', 'forbidden']

/** Null when the failure is transient and verification should keep retrying. */
export function runtimeHostStatusBlockedReason(
  response: RuntimeRpcFailure
): RuntimeHostBlockedReason | null {
  if (ACCESS_REVOKED_CODES.includes(response.error.code)) {
    return 'access-revoked'
  }
  return [
    'invalid_argument',
    'invalid_runtime_response',
    'protocol_version_mismatch',
    'method_not_found',
    'unsupported_method'
  ].includes(response.error.code)
    ? 'incompatible'
    : null
}
