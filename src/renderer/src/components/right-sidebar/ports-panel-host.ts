import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { hostRouteForAuthority, type HostRoute } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  getOrcadSshDeployment,
  type OrcadDeploymentLink
} from '../../../../shared/runtime-environments'
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
  // Focus cannot resolve workspace ownership because Active Server may name another host (#24067).
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
  // Recipe VMs lack connection state; host-scoped scans distinguish no listeners from unreachable hosts.
  if (authority.endpoint.kind === 'self' && !isRuntimeOwnedSshTargetId(host.targetId)) {
    return { kind: 'direct-ssh', connectionId: host.targetId }
  }
  return { kind: 'host-scoped', route, executionHostId: authority.at }
}

/** The Ports tab shows for a workspace on an SSH host, dialed directly or through its managed server. */
export function portsPanelReachesSshHost(
  host: PortsPanelHost,
  environments: readonly { id: string; orcadDeployment?: unknown }[]
): boolean {
  switch (host.kind) {
    case 'direct-ssh':
    case 'host-scoped':
      return true
    case 'endpoint': {
      const { target } = host
      return (
        target.kind === 'environment' &&
        environments.some(
          (environment) =>
            environment.id === target.environmentId && environment.orcadDeployment !== undefined
        )
      )
    }
    case 'unknown':
      return false
  }
}

/** Managed servers scan their ports, but client forwards still ride the SSH tunnel to their host (#29153). */
export function portsPanelForwardTargetId(
  host: PortsPanelHost,
  environments: readonly { id: string; orcadDeployment?: OrcadDeploymentLink }[]
): string | null {
  if (host.kind !== 'endpoint' || host.target.kind !== 'environment') {
    return null
  }
  const { environmentId } = host.target
  const environment = environments.find((candidate) => candidate.id === environmentId)
  return (environment && getOrcadSshDeployment(environment)?.sshTargetId) || null
}
