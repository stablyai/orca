import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
import {
  getOrcadSshDeployment,
  type OrcadDeploymentLink
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

type ServerPortForwardState = Omit<WorktreeOperationRouteState, 'runtimeEnvironments'> & {
  runtimeEnvironments?: readonly { id: string; orcadDeployment?: OrcadDeploymentLink }[]
  /** This desktop's own SSH targets; a paired server's targets live on that server. */
  sshTargetLabels?: ReadonlyMap<string, string>
}

// The store registers itself so link routing need not import it.
let readOwnerState: (() => ServerPortForwardState) | null = null

export function registerServerPortForwardStateAccessor(fn: () => ServerPortForwardState): void {
  readOwnerState = fn
}

/** A server Orca deployed over SSH forwards through that SSH connection, as its Ports panel does. */
export function serverSshForwardTargetId(environmentId: string): string | null {
  const environment = readOwnerState?.()?.runtimeEnvironments?.find(
    (candidate) => candidate.id === environmentId
  )
  return (environment && getOrcadSshDeployment(environment)?.sshTargetId) || null
}

/** Whether this desktop can forward an SSH host's localhost ports over its own connection to it. */
export function sshForwardsPorts(targetId: string): boolean {
  return (
    typeof window !== 'undefined' &&
    window.api?.ssh?.ensurePortForward !== undefined &&
    readOwnerState?.()?.sshTargetLabels?.has(targetId) === true
  )
}

/** Whether this desktop can forward the paired server's localhost ports: over SSH for a server
 *  deployed that way, else over its own connection, from its last probed status. */
export function serverForwardsPorts(environmentId: string): boolean {
  const sshTargetId = serverSshForwardTargetId(environmentId)
  if (sshTargetId !== null) {
    return sshForwardsPorts(sshTargetId)
  }
  return (
    typeof window !== 'undefined' &&
    window.api?.runtimeEnvironments?.portForwards !== undefined &&
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY
    ) === true
  )
}

/** The workspace runs on the paired server itself; one on an SSH host or WSL distro the server reaches has another localhost. */
export function workspaceRunsOnServer(
  environmentId: string,
  worktreeId: string | null | undefined
): boolean {
  const state = readOwnerState?.()
  if (!state || !worktreeId) {
    return false
  }
  // The owner keeps a nested SSH target as its place; `local` is the server's own machine.
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  return (
    owner.kind === 'resolved' &&
    owner.owner.endpoint.kind === 'environment' &&
    owner.owner.endpoint.environmentId === environmentId &&
    owner.owner.at === 'local'
  )
}

/** A system-browser open of this workspace's server localhost can go through a forward of that port. */
export function serverForwardsWorkspacePorts(
  environmentId: string,
  worktreeId: string | null | undefined
): boolean {
  return serverForwardsPorts(environmentId) && workspaceRunsOnServer(environmentId, worktreeId)
}
