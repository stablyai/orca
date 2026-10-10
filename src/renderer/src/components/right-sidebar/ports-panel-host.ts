import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  hostRouteForAuthority,
  type HostRoute,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  authorityKey,
  parseHostAuthorityKey,
  type HostAuthorityKey
} from '../../../../shared/host-authority'

/** Where the Ports panel looks for the active workspace's listeners. */
export type PortsPanelHost =
  /** No single owner; the panel says so instead of scanning some other host. */
  | { kind: 'unknown' }
  /** An SSH target this client dials itself, recipe VMs included. */
  | { kind: 'direct-ssh'; connectionId: string }
  /** The machine an endpoint (this app or a paired server) runs on. */
  | { kind: 'endpoint'; target: RuntimeClientTarget }
  /** An SSH target behind a paired server; scanned by that server, never by this client. */
  | { kind: 'server-ssh'; route: HostRoute; environmentId: string; executionHostId: string }

/** The active workspace's owner as a stable string for store selectors; null when unknown. */
export function getPortsPanelOwnerKey(
  state: WorktreeOperationRouteState,
  workspaceId: string | null | undefined
): HostAuthorityKey | null {
  if (!workspaceId) {
    return null
  }
  // Why no Active Server fallback: focus names a host unrelated to the workspace (#24067).
  const owner = resolveOwner(state, { workspaceId })
  return owner.kind === 'resolved' ? authorityKey(owner.owner) : null
}

export function portsPanelHostForOwnerKey(key: HostAuthorityKey | null): PortsPanelHost {
  const authority = parseHostAuthorityKey(key)
  if (!authority) {
    return { kind: 'unknown' }
  }
  const route = hostRouteForAuthority(authority)
  if (authority.at === 'local') {
    return { kind: 'endpoint', target: route.target }
  }
  if (authority.endpoint.kind === 'self') {
    const host = parseExecutionHostId(authority.at)
    return host?.kind === 'ssh'
      ? { kind: 'direct-ssh', connectionId: host.targetId }
      : { kind: 'unknown' }
  }
  return {
    kind: 'server-ssh',
    route,
    environmentId: authority.endpoint.environmentId,
    executionHostId: authority.at
  }
}
