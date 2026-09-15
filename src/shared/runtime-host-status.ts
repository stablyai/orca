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
  connectionGeneration?: number
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
