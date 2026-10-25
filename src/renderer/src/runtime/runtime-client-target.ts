import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  parseHostAuthorityKey,
  type HostAuthority,
  type HostAuthorityKey
} from '../../../shared/host-authority'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** Transport to an owner's runtime environment; `null` is this app (local or direct SSH). */
export function runtimeTargetForOwnerEnvironment(
  environmentId: string | null
): RuntimeClientTarget {
  const ownerId = environmentId?.trim()
  return ownerId ? { kind: 'environment', environmentId: ownerId } : { kind: 'local' }
}

/** The host id a transport dials: the server's runtime host, or this app. */
export function getRuntimeTargetHostId(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'environment'
    ? toRuntimeExecutionHostId(target.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}

/** The server a transport dials, or `null` for this app. */
export function runtimeTargetEnvironmentId(target: RuntimeClientTarget): string | null {
  return target.kind === 'environment' ? target.environmentId : null
}

/**
 * Transport to the host that owns a row: a server's own runtime, or this app for local and `ssh:`
 * rows (this app serves no SSH route, so its IPC refuses those). `null` when the id names no
 * routable host.
 */
export function ipcOrRuntimeTargetForHostId(
  hostId: ExecutionHostId | null | undefined
): RuntimeClientTarget | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  if (!parsed) {
    return null
  }
  return parsed.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

/**
 * RPC target for a dispatchable host; direct SSH and the unresolved-owner sentinel have none. A
 * nested authority key routes to the server that owns the SSH target.
 */
export function runtimeRpcTargetForAuthorityKey(
  hostId: HostAuthorityKey
): RuntimeClientTarget | null {
  const authority = parseHostAuthorityKey(hostId)
  if (!authority) {
    return null
  }
  if (authority.endpoint.kind === 'environment') {
    return { kind: 'environment', environmentId: authority.endpoint.environmentId }
  }
  return authority.at === 'local' ? { kind: 'local' } : null
}

/**
 * Transport plus place. `at` stays off `RuntimeClientTarget` because fences and caches key on the
 * target; folding it in would merge `(E, ssh:t)` into `runtime:E`.
 */
export type HostRoute = { target: RuntimeClientTarget; at: HostAuthority['at'] }

export function hostRouteForAuthority(authority: HostAuthority): HostRoute {
  const { endpoint } = authority
  return {
    target:
      endpoint.kind === 'self'
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: endpoint.environmentId },
    at: authority.at
  }
}
