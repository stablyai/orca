/**
 * Which host a resource belongs to, as the pair the client needs to reach it: the Orca endpoint that
 * serves it (this app, or a paired server) and the place on that endpoint where it executes (the
 * endpoint's own machine, or one of its SSH targets).
 *
 * An `ExecutionHostId` alone cannot say "SSH target t behind server E": `ssh:t` reads as a target
 * this client dials itself. The pair can, and {@link authorityKey} keeps every spelling that already
 * exists so no persisted key changes.
 */
import {
  LOCAL_EXECUTION_HOST_ID,
  isUnresolvedOwnerHostId,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export type HostAuthorityEndpoint =
  | { kind: 'self' }
  | { kind: 'environment'; environmentId: string }

export type HostAuthority = {
  endpoint: HostAuthorityEndpoint
  /** Relative to `endpoint`: its own machine, or one of its SSH targets. */
  at: typeof LOCAL_EXECUTION_HOST_ID | `ssh:${string}`
}

/** A resource named by its owner, so adapters derive params and route from one value. */
export type HostRef = { authority: HostAuthority; id: string }

const NESTED_PREFIX = 'nested:'

/**
 * In-memory only, never persisted. The nested spelling is deliberately not an `ExecutionHostId`:
 * every host-id parser rejects it, so a leaked key fails closed instead of collapsing to `runtime:E`.
 */
export type HostAuthorityKey = ExecutionHostId | `${typeof NESTED_PREFIX}${string}`

export const SELF_LOCAL_AUTHORITY: HostAuthority = {
  endpoint: { kind: 'self' },
  at: LOCAL_EXECUTION_HOST_ID
}

export function authorityKey(authority: HostAuthority): HostAuthorityKey {
  if (authority.endpoint.kind === 'self') {
    return authority.at
  }
  const runtimeHostId = toRuntimeExecutionHostId(authority.endpoint.environmentId)
  if (authority.at === LOCAL_EXECUTION_HOST_ID) {
    return runtimeHostId
  }
  return `${NESTED_PREFIX}${runtimeHostId.slice('runtime:'.length)}/${authority.at.slice('ssh:'.length)}`
}

function environmentEndpoint(environmentId: string): HostAuthorityEndpoint | null {
  return environmentId.trim() && !isUnresolvedOwnerHostId(toRuntimeExecutionHostId(environmentId))
    ? { kind: 'environment', environmentId }
    : null
}

/** Inverse of {@link authorityKey}; null for anything unparseable or the unresolved sentinel. */
export function parseHostAuthorityKey(key: string | null | undefined): HostAuthority | null {
  if (key?.startsWith(NESTED_PREFIX)) {
    const parts = key.slice(NESTED_PREFIX.length).split('/')
    if (parts.length !== 2) {
      return null
    }
    const runtime = parseRoutableExecutionHostId(`runtime:${parts[0]}`)
    const ssh = parseRoutableExecutionHostId(`ssh:${parts[1]}`)
    const endpoint = runtime?.kind === 'runtime' ? environmentEndpoint(runtime.environmentId) : null
    return endpoint && ssh?.kind === 'ssh' ? { endpoint, at: ssh.id } : null
  }
  const authority = hostAuthorityFromOperationRoute({
    executionHostId: key ?? null,
    runtimeEnvironmentId: null
  })
  return authority === 'contradictory' ? null : authority
}

/**
 * Reads the renderer's existing `{ executionHostId, runtimeEnvironmentId }` route as an authority.
 * `runtimeEnvironmentId` is the transport; `executionHostId` is the host as the row names it.
 * Returns null when no usable owner is named, and `'contradictory'` when the two disagree.
 */
export function hostAuthorityFromOperationRoute(route: {
  executionHostId: string | null
  runtimeEnvironmentId: string | null
}): HostAuthority | null | 'contradictory' {
  const host = route.executionHostId ? parseRoutableExecutionHostId(route.executionHostId) : null
  if (route.executionHostId && !host) {
    return null
  }
  const transportId = route.runtimeEnvironmentId?.trim()
  if (!transportId) {
    if (!host) {
      return null
    }
    if (host.kind === 'runtime') {
      const endpoint = environmentEndpoint(host.environmentId)
      return endpoint ? { endpoint, at: LOCAL_EXECUTION_HOST_ID } : null
    }
    return { endpoint: { kind: 'self' }, at: host.id }
  }
  const endpoint = environmentEndpoint(transportId)
  if (!endpoint) {
    return null
  }
  if (host?.kind === 'ssh') {
    return { endpoint, at: host.id }
  }
  if (host?.kind === 'runtime' && host.environmentId !== transportId) {
    return 'contradictory'
  }
  // A `local` host on a paired server's row is local to that server.
  return { endpoint, at: LOCAL_EXECUTION_HOST_ID }
}
