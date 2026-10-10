import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  hostRouteForAuthority,
  type HostRoute,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  authorityKey,
  parseHostAuthorityKey,
  type HostAuthorityKey
} from '../../../../shared/host-authority'

/** Where the Ports panel looks for the active workspace's listeners. */
export type PortsPanelHost =
  /** No single owner; the panel says so instead of scanning some other host. */
  | { kind: 'unknown' }
  /** A user SSH target this client dials itself; its view also manages forwards. */
  | { kind: 'direct-ssh'; connectionId: string }
  /** The machine an endpoint (this app or a paired server) runs on. */
  | { kind: 'endpoint'; target: RuntimeClientTarget }
  /** An SSH host scanned by the endpoint that owns it, which reports whether it could look. */
  | { kind: 'host-scoped'; route: HostRoute; executionHostId: string }

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
  const host = parseExecutionHostId(authority.at)
  if (host?.kind !== 'ssh') {
    return { kind: 'unknown' }
  }
  // Why recipe VMs go host-scoped: their targets publish no connection state to the renderer, so
  // only this app's own scan can tell a reachable VM with no listeners from an unreachable one.
  if (authority.endpoint.kind === 'self' && !isRuntimeOwnedSshTargetId(host.targetId)) {
    return { kind: 'direct-ssh', connectionId: host.targetId }
  }
  return { kind: 'host-scoped', route, executionHostId: authority.at }
}
