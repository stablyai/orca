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
 * The last status the host actually answered with. The snapshot retains it across an
 * unverifiable probe, so this survives a loss of contact; the entry's own `status` does not.
 */
export function lastVerifiedRuntimeStatus(
  entry: { status?: RuntimeStatus | null; snapshot?: RuntimeHostStatusSnapshot } | null | undefined
): RuntimeStatus | null {
  return entry?.snapshot?.status ?? entry?.status ?? null
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
