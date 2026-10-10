import type { GlobalSettings } from '../../../shared/global-settings-types'
import { parseRoutableExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  parseHostAuthorityKey,
  type HostAuthority,
  type HostAuthorityKey
} from '../../../shared/host-authority'

export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

export function getActiveRuntimeTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RuntimeClientTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

/** Transport to an owner's runtime environment; `null` is this app (local or direct SSH). */
export function runtimeTargetForOwnerEnvironment(
  environmentId: string | null
): RuntimeClientTarget {
  const ownerId = environmentId?.trim()
  return ownerId ? { kind: 'environment', environmentId: ownerId } : { kind: 'local' }
}

/**
 * Transport to the host that owns a row: a server's own runtime, or this app for local and direct
 * SSH (which ride this app's IPC with a `connectionId`). `null` when the id names no routable host.
 */
export function runtimeTargetForOwnerHostId(
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
export function runtimeTargetForExecutionHostId(
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

export function settingsForRuntimeOwner(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  if (runtimeEnvironmentId === null) {
    return { activeRuntimeEnvironmentId: null }
  }
  const ownerId = runtimeEnvironmentId?.trim()
  return ownerId ? { activeRuntimeEnvironmentId: ownerId } : settings
}
